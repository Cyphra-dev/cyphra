import { parseSchema, printSchemaDocument, resolveSchema } from "@cyphra/schema";
import { CyphraClient } from "@cyphra/runtime";
import { afterAll, describe, expect, it } from "vitest";
import { diffSchemaModels, EMPTY_SCHEMA_MODEL } from "./diff.js";
import { introspectDatabase, schemaFromIntrospection } from "./introspect.js";
import { fulltextIndexStatementsFromSchema, vectorIndexStatementsFromSchema } from "./push.js";
import { applyConstraintStatements } from "./runner.js";
import { createMigrationDb } from "./migrationDb.js";

const hasNeo = Boolean(
  process.env.NEO4J_TEST_URI && process.env.NEO4J_TEST_USER && process.env.NEO4J_TEST_PASSWORD,
);

/** Executes a plan the way a generated migration would (guards throw; destructive steps skipped). */
async function applyPlan(client: CyphraClient, plan: ReturnType<typeof diffSchemaModels>) {
  await client.withSession(async (session) => {
    const db = createMigrationDb(client, session);
    for (const step of plan.steps) {
      if (step.kind === "statement") await db.execute(step.cypher, { ...step.params });
      if (step.kind === "guard") {
        const [row] = await db.execute(step.countCypher);
        if (Number(row?.count) > 0) throw new Error(step.message);
      }
    }
  });
}

describe.skipIf(!hasNeo)("schema migrations and pull (Neo4j)", () => {
  const client = hasNeo
    ? new CyphraClient({
        uri: process.env.NEO4J_TEST_URI!,
        user: process.env.NEO4J_TEST_USER!,
        password: process.env.NEO4J_TEST_PASSWORD!,
      })
    : (undefined as unknown as CyphraClient);
  const run = (text: string) => client.withSession(async (s) => (await s.run(text)).records);

  afterAll(async () => {
    await run("MATCH (n:MigUser) DETACH DELETE n");
    for (const name of ["MigUser_id_id", "MigUser_email_unique", "MigUser_handle_unique"]) {
      await run(`DROP CONSTRAINT ${name} IF EXISTS`);
    }
    await client?.close();
  });

  it("applies generated DDL, backfills defaults and stops on guards", async () => {
    await run("MATCH (n:MigUser) DETACH DELETE n");
    const v1 = resolveSchema(parseSchema(`node MigUser { id String @id\n email String @unique }`));
    await applyPlan(client, diffSchemaModels(EMPTY_SCHEMA_MODEL, v1));
    await run(
      "CREATE (:MigUser {id: 'a', email: 'a@x.io'}), (:MigUser {id: 'b', email: 'b@x.io'})",
    );

    const v2 = resolveSchema(
      parseSchema(
        `node MigUser { id String @id\n email String @unique\n role String @default("member")\n n Int @default(1)\n handle String @unique }`,
      ),
    );
    const plan = diffSchemaModels(v1, v2);
    await expect(applyPlan(client, plan)).rejects.toThrow(/MigUser\.handle is required/);
    await run("MATCH (u:MigUser) SET u.handle = u.id");
    await applyPlan(client, plan);

    const rows = await run(
      "MATCH (u:MigUser) RETURN u.role AS role, valueType(u.n) AS t ORDER BY u.id",
    );
    expect(rows.map((r) => [r.get("role"), r.get("t")])).toEqual([
      ["member", "INTEGER NOT NULL"],
      ["member", "INTEGER NOT NULL"],
    ]);
    await expect(
      run("CREATE (:MigUser {id: 'c', email: 'c@x.io', handle: 'a'})"),
    ).rejects.toThrow();
  });

  it("pulls a schema that round-trips through the parser", async () => {
    const { doc } = schemaFromIntrospection(await introspectDatabase(client));
    const src = printSchemaDocument(doc);
    expect(() => resolveSchema(parseSchema(src))).not.toThrow();
    expect(src).toMatch(/node MigUser \{\n {2}id String @id\n/);
    expect(src).toContain("handle String @unique");
    expect(src).toContain("n Int");
  });

  it("pulls a shared label as an interface", async () => {
    const clean = "MATCH (n:PullPerson) DETACH DELETE n";
    await run(clean);
    try {
      await run(
        "CREATE (:PullEmp:PullPerson {pid: 'e', pname: 'E', salary: 1}), (:PullCust:PullPerson {pid: 'c', pname: 'C', tier: 'gold'})",
      );
      const src = printSchemaDocument(
        schemaFromIntrospection(await introspectDatabase(client)).doc,
      );
      expect(src).toContain("interface PullPerson {\n  pid String\n  pname String\n}");
      expect(src).toContain("node PullEmp implements PullPerson {\n  salary Int\n}");
      expect(src).toContain("node PullCust implements PullPerson {\n  tier String\n}");
      expect(() => resolveSchema(parseSchema(src))).not.toThrow();
    } finally {
      await run(clean);
    }
  });

  it("creates vector indexes, recreates them on change, and pulls them back", async () => {
    const v1 = `node MigVector {
  id String @id
  embedding Vector(3)? @vectorIndex(similarity: cosine, name: "mig_vector")
}
`;
    const v2 = v1.replace("Vector(3)?", "Vector(4)?").replace("cosine", "euclidean");
    const indexInfo = async () =>
      client.withSession(async (s) => {
        await s.run("CALL db.awaitIndexes(120)");
        const res = await s.run(
          "SHOW VECTOR INDEXES YIELD name, state, labelsOrTypes, properties, options WHERE name = 'mig_vector' RETURN *",
        );
        return res.records.map((r) => {
          const config = (r.get("options") as { indexConfig: Record<string, unknown> }).indexConfig;
          return {
            state: r.get("state") as string,
            on: [...(r.get("labelsOrTypes") as string[]), ...(r.get("properties") as string[])],
            dimensions: Number(config["vector.dimensions"]),
            similarity: config["vector.similarity_function"],
          };
        });
      });
    try {
      await client.withSession((s) =>
        s.run("DROP INDEX mig_vector IF EXISTS").then(() => undefined),
      );
      const stmts = vectorIndexStatementsFromSchema(parseSchema(v1));
      await applyConstraintStatements(client, stmts);
      await applyConstraintStatements(client, stmts); // IF NOT EXISTS: idempotent
      expect(await indexInfo()).toEqual([
        {
          state: "ONLINE",
          on: ["MigVector", "embedding"],
          dimensions: 3,
          similarity: "COSINE",
        },
      ]);

      // `cyphra pull` maps the index back to the same field.
      await client.withSession((s) =>
        s
          .run("CREATE (:MigVector {id: 'v', embedding: [0.1, 0.2, 0.3]}), (:MigVector {id: 'w'})")
          .then(() => undefined),
      );
      const pulled = printSchemaDocument(
        schemaFromIntrospection(await introspectDatabase(client)).doc,
      );
      expect(pulled).toContain(
        'embedding Vector(3)? @vectorIndex(similarity: cosine, name: "mig_vector")',
      );

      // A migration from v1 to v2 drops and recreates the index with the new options.
      const plan = diffSchemaModels(resolveSchema(parseSchema(v1)), resolveSchema(parseSchema(v2)));
      await applyConstraintStatements(
        client,
        plan.steps.flatMap((step) => (step.kind === "statement" ? [step.cypher] : [])),
      );
      expect(await indexInfo()).toEqual([
        {
          state: "ONLINE",
          on: ["MigVector", "embedding"],
          dimensions: 4,
          similarity: "EUCLIDEAN",
        },
      ]);
    } finally {
      await run("MATCH (n:MigVector) DETACH DELETE n");
      await run("DROP INDEX mig_vector IF EXISTS");
    }
  });

  it("creates point indexes, backfills temporal defaults and pulls the new types back", async () => {
    const v1 = resolveSchema(parseSchema(`node MigGeo { id String @id }`));
    const v2 = resolveSchema(
      parseSchema(`node MigGeo {
  id String @id
  loc Point? @index
  grid CartesianPoint?
  opens LocalTime @default("09:00")
  seen LocalDateTime @default(now())
  at Time @default(now())
  stay Duration @default("PT90M")
}`),
    );
    try {
      await run("MATCH (n:MigGeo) DETACH DELETE n");
      await applyPlan(client, diffSchemaModels(EMPTY_SCHEMA_MODEL, v1));
      await run("CREATE (:MigGeo {id: 'a'})");
      await applyPlan(client, diffSchemaModels(v1, v2));
      await run(
        "MATCH (n:MigGeo {id: 'a'}) SET n.loc = point({longitude: 2.35, latitude: 48.85}), n.grid = point({x: 1, y: 2})",
      );
      const [row] = await run(`
        MATCH (n:MigGeo {id: 'a'})
        RETURN toString(n.opens) AS opens, valueType(n.seen) AS seen, valueType(n.at) AS at,
               toString(n.stay) AS stay`);
      expect(row!.toObject()).toEqual({
        opens: "09:00:00",
        seen: "LOCAL DATETIME NOT NULL",
        at: "ZONED TIME NOT NULL",
        stay: "PT1H30M",
      });
      const [index] = await run(
        "SHOW INDEXES YIELD name, type, labelsOrTypes, properties WHERE name = 'MigGeo_loc_idx' RETURN *",
      );
      expect(index!.toObject()).toEqual({
        name: "MigGeo_loc_idx",
        type: "POINT",
        labelsOrTypes: ["MigGeo"],
        properties: ["loc"],
      });
      const pulled = printSchemaDocument(
        schemaFromIntrospection(await introspectDatabase(client)).doc,
      );
      const node = /node MigGeo \{[^}]*\}/.exec(pulled)![0];
      expect(node).toContain("loc Point @index");
      expect(node).toContain("grid CartesianPoint");
      expect(node).toContain("opens LocalTime");
      expect(node).toContain("seen LocalDateTime");
      expect(node).toContain("at Time");
      expect(node).toContain("stay Duration");
    } finally {
      await run("MATCH (n:MigGeo) DETACH DELETE n");
      await run("DROP INDEX MigGeo_loc_idx IF EXISTS");
      await run("DROP CONSTRAINT MigGeo_id_id IF EXISTS");
    }
  });

  it("creates full-text indexes, recreates them on change, and pulls them back", async () => {
    const v1 = `node MigText {
  id    String   @id
  title String
  body  String?
  tags  String[]

  @@fulltext([title, body], name: "mig_text", analyzer: "english")
}
`;
    const v2 = v1.replace("[title, body]", "[title, body, tags]").replace("english", "whitespace");
    const indexInfo = async () =>
      client.withSession(async (s) => {
        await s.run("CALL db.awaitIndexes(120)");
        const res = await s.run(
          "SHOW FULLTEXT INDEXES YIELD name, state, labelsOrTypes, properties, options WHERE name = 'mig_text' RETURN *",
        );
        return res.records.map((r) => {
          const config = (r.get("options") as { indexConfig: Record<string, unknown> }).indexConfig;
          return {
            state: r.get("state") as string,
            on: [...(r.get("labelsOrTypes") as string[]), ...(r.get("properties") as string[])],
            analyzer: config["fulltext.analyzer"],
            eventuallyConsistent: config["fulltext.eventually_consistent"],
          };
        });
      });
    try {
      await run("DROP INDEX mig_text IF EXISTS");
      const stmts = fulltextIndexStatementsFromSchema(parseSchema(v1));
      await applyConstraintStatements(client, stmts);
      await applyConstraintStatements(client, stmts); // IF NOT EXISTS: idempotent
      expect(await indexInfo()).toEqual([
        {
          state: "ONLINE",
          on: ["MigText", "title", "body"],
          analyzer: "english",
          eventuallyConsistent: false,
        },
      ]);

      // `cyphra pull` maps the index back to the same attribute.
      await run(
        "CREATE (:MigText {id: 'a', title: 'Graphs', body: 'x', tags: ['t']}), (:MigText {id: 'b', title: 'Trees'})",
      );
      const pulled = printSchemaDocument(
        schemaFromIntrospection(await introspectDatabase(client)).doc,
      );
      expect(pulled).toContain(
        '  @@fulltext([title, body], name: "mig_text", analyzer: "english")',
      );

      // A migration from v1 to v2 drops and recreates the index with the new fields and analyzer.
      const plan = diffSchemaModels(resolveSchema(parseSchema(v1)), resolveSchema(parseSchema(v2)));
      await applyConstraintStatements(
        client,
        plan.steps.flatMap((step) => (step.kind === "statement" ? [step.cypher] : [])),
      );
      expect(await indexInfo()).toEqual([
        {
          state: "ONLINE",
          on: ["MigText", "title", "body", "tags"],
          analyzer: "whitespace",
          eventuallyConsistent: false,
        },
      ]);
    } finally {
      await run("MATCH (n:MigText) DETACH DELETE n");
      await run("DROP INDEX mig_text IF EXISTS");
    }
  });

  it("creates composite constraints and indexes, recreates them on change, and pulls them back", async () => {
    const v1 = `node MigPair {
  id       String @id
  provider String
  account  String
  at       Int

  @@unique([provider, account])
  @@index([provider, at], name: "mig_pair_at")
}
`;
    const v2 = v1.replace("[provider, account]", "[account, at]");
    const names = ["MigPair_id_id", "MigPair_provider_account_unique", "MigPair_account_at_unique"];
    const cleanup = async () => {
      await run("MATCH (n:MigPair) DETACH DELETE n");
      for (const name of names) await run(`DROP CONSTRAINT ${name} IF EXISTS`);
      await run("DROP INDEX mig_pair_at IF EXISTS");
    };
    const schemaInfo = async () =>
      client.withSession(async (s) => {
        await s.run("CALL db.awaitIndexes(120)");
        const constraints = await s.run(
          "SHOW CONSTRAINTS YIELD name, type, properties WHERE name STARTS WITH 'MigPair_' AND size(properties) > 1 RETURN name, type, properties",
        );
        const indexes = await s.run(
          "SHOW INDEXES YIELD name, type, properties WHERE name = 'mig_pair_at' RETURN name, type, properties",
        );
        return [...constraints.records, ...indexes.records].map((r) => r.toObject());
      });
    try {
      await cleanup();
      const plan1 = diffSchemaModels(EMPTY_SCHEMA_MODEL, resolveSchema(parseSchema(v1)));
      await applyPlan(client, plan1);
      expect(await schemaInfo()).toEqual([
        {
          name: "MigPair_provider_account_unique",
          type: "UNIQUENESS",
          properties: ["provider", "account"],
        },
        { name: "mig_pair_at", type: "RANGE", properties: ["provider", "at"] },
      ]);
      await run("CREATE (:MigPair {id: 'a', provider: 'gh', account: '1', at: 1})");
      await expect(
        run("CREATE (:MigPair {id: 'b', provider: 'gh', account: '1', at: 2})"),
      ).rejects.toMatchObject({ code: "Neo.ClientError.Schema.ConstraintValidationFailed" });

      const pulled = printSchemaDocument(
        schemaFromIntrospection(await introspectDatabase(client)).doc,
      );
      expect(pulled).toContain("  @@unique([provider, account])\n");
      expect(pulled).toContain('  @@index([provider, at], name: "mig_pair_at")\n');

      const plan2 = diffSchemaModels(
        resolveSchema(parseSchema(v1)),
        resolveSchema(parseSchema(v2)),
      );
      await applyPlan(client, plan2);
      expect((await schemaInfo()).map((o) => o.name)).toEqual([
        "MigPair_account_at_unique",
        "mig_pair_at",
      ]);
    } finally {
      await cleanup();
    }
  });

  it("backfills an interface label, moves the constraint to it, and removes it again", async () => {
    const constraints = [
      "MigEmp_id_id",
      "MigEmp_email_unique",
      "MigCust_id_id",
      "MigPerson_id_id",
      "MigPerson_email_unique",
    ];
    const clean = async () => {
      await run("MATCH (n) WHERE n:MigEmp OR n:MigCust OR n:MigPerson DETACH DELETE n");
      for (const name of constraints) await run(`DROP CONSTRAINT ${name} IF EXISTS`);
    };
    await clean();
    try {
      const v1 = resolveSchema(
        parseSchema(`
          node MigEmp { id String @id
            email String @unique }
          node MigCust { id String @id
            email String }
        `),
      );
      await applyPlan(client, diffSchemaModels(EMPTY_SCHEMA_MODEL, v1));
      await run("CREATE (:MigEmp {id: 'e1', email: 'a@x'}), (:MigCust {id: 'c1', email: 'b@x'})");

      const v2 = resolveSchema(
        parseSchema(`
          interface MigPerson { id String @id
            email String @unique }
          node MigEmp implements MigPerson {}
          node MigCust implements MigPerson {}
        `),
      );
      await applyPlan(client, diffSchemaModels(v1, v2));
      const rows = await run("MATCH (n:MigPerson) RETURN n.id AS id ORDER BY id");
      expect(rows.map((r) => r.get("id"))).toEqual(["c1", "e1"]);
      // The email constraint now spans both implementations.
      await expect(run("CREATE (:MigCust:MigPerson {id: 'c2', email: 'a@x'})")).rejects.toThrow();
      const names = (await run("SHOW CONSTRAINTS YIELD name RETURN name")).map((r) =>
        r.get("name"),
      );
      expect(names).toContain("MigPerson_email_unique");
      expect(names).not.toContain("MigEmp_email_unique");

      await applyPlan(client, diffSchemaModels(v2, v1));
      const count = async (label: string) =>
        Number((await run(`MATCH (n:${label}) RETURN count(n) AS c`))[0]!.get("c"));
      expect(await count("MigPerson")).toBe(0);
      expect(await count("MigEmp")).toBe(1);
    } finally {
      await clean();
    }
  });
});
