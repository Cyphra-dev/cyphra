/**
 * `cyphra push`, migrations, drift detection and `cyphra pull` against Memgraph (run with
 * `CYPHRA_TEST_DIALECT=memgraph` and `NEO4J_TEST_URI` pointing at a Memgraph server).
 */
import { parseSchema, printSchemaDocument, resolveSchema } from "@cyphra/schema";
import { CyphraClient, UnsupportedFeatureError } from "@cyphra/runtime";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { EMPTY_SCHEMA_MODEL, diffSchemaModels } from "./diff.js";
import {
  compareSchemaObjects,
  expectedSchemaFromModel,
  readSchemaObjects,
  replayMigrations,
} from "./drift.js";
import { introspectDatabase, schemaFromIntrospection } from "./introspect.js";
import {
  constraintStatementsFromSchema,
  fulltextIndexStatementsFromSchema,
  indexStatementsFromSchema,
  vectorIndexStatementsFromSchema,
} from "./push.js";
import { applyConstraintStatements, runPendingMigrations, type LoadedMigration } from "./runner.js";
import { listAppliedMigrations } from "./tracker.js";
import { memgraphDropStatement } from "./memgraph.js";
import type { SchemaObject } from "./drift.js";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const hasMemgraph =
  process.env.CYPHRA_TEST_DIALECT === "memgraph" &&
  Boolean(
    process.env.NEO4J_TEST_URI && process.env.NEO4J_TEST_USER && process.env.NEO4J_TEST_PASSWORD,
  );

const SCHEMA = `
node MgmUser {
  id        String     @id
  email     String     @unique
  name      String     @index
  location  Point?     @index
  tenant    String
  handle    String
  joinedAt  Int
  tags      String[]
  embedding Vector(3)? @vectorIndex(similarity: cosine, name: "mgm_embedding")
  follows   MgmUser[]  @relationship(type: "MGM_FOLLOWS", direction: OUT)

  @@unique([tenant, handle])
  @@index([tenant, joinedAt])
  @@fulltext([name, handle], name: "mgmUserSearch")
}

relationship MgmFollows {
  type "MGM_FOLLOWS"
  from MgmUser
  to   MgmUser
  since Int @index
}
`;

const ours = (objects: readonly SchemaObject[]) =>
  objects.filter((o) => o.labelsOrTypes.some((l) => l.startsWith("Mgm") || l.startsWith("MGM")));

describe.skipIf(!hasMemgraph)("migrator on Memgraph", () => {
  const client = hasMemgraph
    ? new CyphraClient({
        uri: process.env.NEO4J_TEST_URI!,
        user: process.env.NEO4J_TEST_USER!,
        password: process.env.NEO4J_TEST_PASSWORD!,
        dialect: "memgraph",
      })
    : (undefined as unknown as CyphraClient);
  const run = (text: string) => client.withSession(async (s) => (await s.run(text)).records);
  const model = resolveSchema(parseSchema(SCHEMA));

  /** Drop every constraint / index on this suite's labels. */
  const cleanup = async () => {
    for (const o of ours(await readSchemaObjects(client))) {
      await run(memgraphDropStatement(o));
    }
    await run("MATCH (n) WHERE any(l IN labels(n) WHERE l STARTS WITH 'Mgm') DETACH DELETE n");
    await run("MATCH (m:__CyphraMigration) WHERE m.name STARTS WITH 'mgm_' DELETE m");
  };

  beforeAll(cleanup);

  afterAll(async () => {
    await cleanup();
    await client?.close();
  });

  it("pushes the schema idempotently and is then in sync with it", async () => {
    const doc = parseSchema(SCHEMA);
    const statements = [
      ...constraintStatementsFromSchema(doc),
      ...indexStatementsFromSchema(doc),
      ...vectorIndexStatementsFromSchema(doc),
      ...fulltextIndexStatementsFromSchema(doc),
    ];
    await applyConstraintStatements(client, statements);
    // Memgraph's CREATE is a no-op for constraints and property indexes; text and vector indexes
    // are created once (they are not pushed again here).
    await applyConstraintStatements(client, [
      ...constraintStatementsFromSchema(doc),
      ...indexStatementsFromSchema(doc),
    ]);
    const report = compareSchemaObjects(
      expectedSchemaFromModel(model, "memgraph"),
      ours(await readSchemaObjects(client)),
    );
    expect(report).toEqual({ extra: [], missing: [], changed: [] });

    // The constraints hold.
    await run("CREATE (:MgmUser {id: 'a', email: 'a@x.io', tenant: 't', handle: 'h'})");
    await expect(
      run("CREATE (:MgmUser {id: 'b', email: 'a@x.io', tenant: 't', handle: 'other'})"),
    ).rejects.toThrow(/unique constraint violation/);
    await expect(
      run("CREATE (:MgmUser {id: 'c', email: 'c@x.io', tenant: 't', handle: 'h'})"),
    ).rejects.toThrow(/unique constraint violation/);
  });

  it("waits for running transactions instead of failing on storage access (#203)", async () => {
    // Memgraph gives DDL 1 s (--storage-access-timeout-sec) to get access to the storage while
    // other transactions run; text index DDL needs unique access.
    const doc = parseSchema(`node MgmBusy { id String @id
  title String
  @@fulltext([title], name: "mgmBusySearch") }`);
    const statements = [
      ...constraintStatementsFromSchema(doc),
      ...fulltextIndexStatementsFromSchema(doc),
    ];
    let opened!: () => void;
    const isOpen = new Promise<void>((r) => (opened = r));
    // Another client's write transaction, open for 2.5 s.
    const held = client.withSession(async (s) => {
      const tx = s.beginTransaction();
      await tx.run("CREATE (:MgmBusy {id: 'held'})");
      opened();
      await new Promise((r) => setTimeout(r, 2_500));
      await tx.commit();
    });
    await isOpen;
    const started = Date.now();
    await applyConstraintStatements(client, statements);
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_500);
    await held;
    const busy = ours(await readSchemaObjects(client)).filter((o) =>
      o.labelsOrTypes.includes("MgmBusy"),
    );
    expect(busy.map((o) => o.name)).toContain("mgmBusySearch");
    for (const o of busy) await run(memgraphDropStatement(o));
    await run("MATCH (n:MgmBusy) DELETE n");
  });

  it("refuses a relationship uniqueness constraint", async () => {
    const doc = parseSchema(`node MgmA { id String @id
  links MgmA[] @relationship(type: "MGM_L", direction: OUT) }
relationship MgmL { type "MGM_L"
  from MgmA
  to MgmA
  ref String @unique }`);
    await expect(
      applyConstraintStatements(client, constraintStatementsFromSchema(doc)),
    ).rejects.toBeInstanceOf(UnsupportedFeatureError);
  });

  it("pulls the schema back from the database", async () => {
    await run(
      "MATCH (u:MgmUser {id: 'a'}) SET u.name = 'Ada', u.joinedAt = 1, u.tags = ['x'], " +
        "u.location = point({longitude: 2.35, latitude: 48.85}), u.embedding = [0.1, 0.2, 0.3] " +
        "CREATE (u)-[:MGM_FOLLOWS {since: 2024}]->(:MgmUser {id: 'z', email: 'z@x.io', name: 'Z', tenant: 't', handle: 'z', joinedAt: 2, tags: []})",
    );
    const { doc, warnings } = schemaFromIntrospection(await introspectDatabase(client));
    const text = printSchemaDocument(doc);
    // Round-trips through the parser and resolver.
    resolveSchema(parseSchema(text));
    const user = text.slice(
      text.indexOf("node MgmUser"),
      text.indexOf("}", text.indexOf("node MgmUser")),
    );
    expect(user).toMatch(/id\s+String\s+@id/);
    expect(user).toMatch(/email\s+String\s+@unique/);
    expect(user).toMatch(/name\s+String\s+@index/);
    expect(user).toMatch(/location\s+Point\?\s+@index/);
    expect(user).toMatch(/tags\s+String\[\]/);
    expect(user).toMatch(
      /embedding\s+Vector\(3\)\?\s+@vectorIndex\(similarity: cosine, name: "mgm_embedding"\)/,
    );
    expect(user).toMatch(/@@unique\(\[handle, tenant\]\)/);
    expect(user).toMatch(/@@index\(\[tenant, joinedAt\]\)/);
    expect(user).toMatch(/@@fulltext\(\[name, handle\], name: "mgmUserSearch"\)/);
    expect(warnings.filter((w) => w.includes("Mgm"))).toEqual([]);
  });

  it("pulls interfaces and dynamic labels", async () => {
    const clean = "MATCH (n) WHERE n:MgmPerson OR n:MgmArch OR n:MgmPost DETACH DELETE n";
    await run(clean);
    try {
      await run(
        "CREATE (:MgmEmp:MgmPerson:MgmArch {pid: 'e', archivedAt: 1, salary: 1}), " +
          "(:MgmCust:MgmPerson {pid: 'c', tier: 'gold'}), " +
          "(:MgmDocA:MgmArch {archivedAt: 2, body: 'x'}), " +
          "(:MgmPost {title: 'a'}), (:MgmPost:MgmHidden {title: 'b'})",
      );
      const { doc, warnings } = schemaFromIntrospection(await introspectDatabase(client));
      const text = printSchemaDocument(doc);
      resolveSchema(parseSchema(text));
      expect(text).toContain("interface MgmPerson {\n  pid String\n}");
      expect(text).toContain("node MgmEmp implements MgmArch, MgmPerson {\n  salary Int\n}");
      expect(text).toContain("node MgmPost {\n  title String\n\n  @@labels([MgmHidden])\n}");
      expect(warnings.filter((w) => /MgmPerson|MgmArch|MgmPost/.test(w))).toEqual([]);
    } finally {
      await run(clean);
    }
  });

  it("applies a generated migration, records it, and reports drift against it", async () => {
    await cleanup();
    const v1 = resolveSchema(
      parseSchema(`node MgmDoc {
  id String @id
  title String @index
  embedding Vector(3)? @vectorIndex(similarity: cosine, name: "mgm_doc_vec")
}`),
    );
    const plan = diffSchemaModels(EMPTY_SCHEMA_MODEL, v1, { dialect: "memgraph" });
    const statements = plan.steps.flatMap((s) => (s.kind === "statement" ? [s.cypher] : []));
    const migration: LoadedMigration = {
      name: "mgm_init",
      checksum: "mgm",
      definition: {
        name: "mgm_init",
        async up({ db }) {
          for (const s of statements) await db.execute(s);
        },
      },
    };
    expect(await runPendingMigrations(client, [migration])).toEqual(["mgm_init"]);
    expect(await runPendingMigrations(client, [migration])).toEqual([]);
    const applied = await client.withSession((s) => listAppliedMigrations(s));
    expect(applied.find((m) => m.name === "mgm_init")?.appliedAt).toBeInstanceOf(Date);

    const drift = async () => {
      const { objects, warnings } = await replayMigrations([migration]);
      expect(warnings).toEqual([]);
      return compareSchemaObjects(objects, ours(await readSchemaObjects(client)));
    };
    expect(await drift()).toEqual({ extra: [], missing: [], changed: [] });

    await run("DROP INDEX ON :`MgmDoc`(`title`)");
    await run("CREATE INDEX ON :MgmDoc(body)");
    await run("DROP VECTOR INDEX mgm_doc_vec");
    await run(
      'CREATE VECTOR INDEX mgm_doc_vec ON :MgmDoc(embedding) WITH CONFIG {"dimension": 4, "capacity": 100, "metric": "l2sq"}',
    );
    const report = await drift();
    expect(report.extra.map((o) => [o.type, o.properties])).toEqual([["RANGE", ["body"]]]);
    expect(report.missing.map((o) => [o.type, o.properties])).toEqual([["RANGE", ["title"]]]);
    expect(report.changed.map((c) => [c.expected.name, c.differences])).toEqual([
      ["mgm_doc_vec", ["dimensions: 3 → 4", "similarity: cosine → euclidean"]],
    ]);

    // The next migration drops by definition and recreates.
    const v2 = resolveSchema(
      parseSchema(`node MgmDoc {
  id String @id
  title String @unique
  embedding Vector(4)? @vectorIndex(similarity: cosine, name: "mgm_doc_vec")
}`),
    );
    const next = diffSchemaModels(v1, v2, { dialect: "memgraph" });
    await applyConstraintStatements(
      client,
      next.steps.flatMap((s) => (s.kind === "statement" ? [s.cypher] : [])),
    );
    const objects = ours(await readSchemaObjects(client));
    expect(compareSchemaObjects(expectedSchemaFromModel(v2, "memgraph"), objects).missing).toEqual(
      [],
    );
  });
});
