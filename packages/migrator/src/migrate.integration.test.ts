import { parseSchema, printSchemaDocument, resolveSchema } from "@cyphra/schema";
import { CyphraClient } from "@cyphra/runtime";
import { afterAll, describe, expect, it } from "vitest";
import { diffSchemaModels, EMPTY_SCHEMA_MODEL } from "./diff.js";
import { introspectDatabase, schemaFromIntrospection } from "./introspect.js";
import { vectorIndexStatementsFromSchema } from "./push.js";
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
});
