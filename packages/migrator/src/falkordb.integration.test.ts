/**
 * `cyphra push`, migrations, drift detection and `cyphra pull` against FalkorDB (run with
 * `CYPHRA_TEST_DIALECT=falkordb` and `FALKORDB_TEST_URL`, e.g. `redis://127.0.0.1:6379`). Uses its
 * own graph (`cyphra_migrator_test`), emptied before and after.
 */
import { parseSchema, printSchemaDocument, resolveSchema } from "@cyphra/schema";
import { CyphraClient, UnsupportedFeatureError } from "@cyphra/runtime";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { renameRelationshipTypeCase } from "./renameTypeCase.testkit.js";
import { EMPTY_SCHEMA_MODEL, diffSchemaModels } from "./diff.js";
import {
  compareSchemaObjects,
  expectedSchemaForDialect,
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
import { dropAllFalkorDBSchema } from "./falkordb.js";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const hasFalkorDB =
  process.env.CYPHRA_TEST_DIALECT === "falkordb" && Boolean(process.env.FALKORDB_TEST_URL);

const SCHEMA = `
node FkmUser {
  id        String     @id
  email     String     @unique
  name      String     @index
  tenant    String
  handle    String
  joinedAt  Int
  tags      String[]
  embedding Vector(3)? @vectorIndex(similarity: cosine, name: "fkm_embedding")
  follows   FkmUser[]  @relationship(type: "FKM_FOLLOWS", direction: OUT)

  @@unique([tenant, handle])
  @@index([tenant, joinedAt])
  @@fulltext([name, handle], name: "fkmUserSearch")
}

relationship FkmFollows {
  type "FKM_FOLLOWS"
  from FkmUser
  to   FkmUser
  since Int @index
  ref   String? @unique
}
`;

describe.skipIf(!hasFalkorDB)("migrator on FalkorDB", () => {
  const client = hasFalkorDB
    ? new CyphraClient({
        falkordb: { url: process.env.FALKORDB_TEST_URL!, graph: "cyphra_migrator_test" },
      })
    : (undefined as unknown as CyphraClient);
  const run = (text: string) => client.withSession(async (s) => (await s.run(text)).records);
  const model = resolveSchema(parseSchema(SCHEMA));

  const cleanup = async () => {
    await dropAllFalkorDBSchema(client);
    await run("MATCH (n) DETACH DELETE n");
  };

  beforeAll(cleanup);

  afterAll(async () => {
    if (!client) return;
    await cleanup();
    await client.close();
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
    // FalkorDB has no IF NOT EXISTS: pushing again is still a no-op.
    await applyConstraintStatements(client, statements);
    const report = compareSchemaObjects(
      expectedSchemaFromModel(model, "falkordb"),
      await readSchemaObjects(client),
    );
    expect(report).toEqual({ extra: [], missing: [], changed: [] });

    // The constraints hold (node, composite and relationship).
    await run("CREATE (:FkmUser {id: 'a', email: 'a@x.io', tenant: 't', handle: 'h'})");
    await expect(
      run("CREATE (:FkmUser {id: 'b', email: 'a@x.io', tenant: 't', handle: 'other'})"),
    ).rejects.toThrow(/unique constraint violation/);
    await expect(
      run("CREATE (:FkmUser {id: 'c', email: 'c@x.io', tenant: 't', handle: 'h'})"),
    ).rejects.toThrow(/unique constraint violation/);
  });

  it("refuses what FalkorDB cannot index", async () => {
    const doc = parseSchema(`node FkmPlace { id String @id
  at Point? @index }`);
    await expect(
      applyConstraintStatements(client, indexStatementsFromSchema(doc)),
    ).rejects.toBeInstanceOf(UnsupportedFeatureError);
  });

  it("pulls the schema back from the database", async () => {
    await run(
      "MATCH (u:FkmUser {id: 'a'}) SET u.name = 'Ada', u.joinedAt = 1, u.tags = ['x'], " +
        "u.embedding = [0.1, 0.2, 0.3] " +
        "CREATE (u)-[:FKM_FOLLOWS {since: 2024, ref: 'r1'}]->(:FkmUser {id: 'z', email: 'z@x.io', name: 'Z', tenant: 't', handle: 'z', joinedAt: 2, tags: ['y']})",
    );
    const { doc } = schemaFromIntrospection(await introspectDatabase(client));
    const text = printSchemaDocument(doc);
    resolveSchema(parseSchema(text));
    const user = text.slice(
      text.indexOf("node FkmUser"),
      text.indexOf("}", text.indexOf("node FkmUser")),
    );
    expect(user).toMatch(/id\s+String\s+@id/);
    expect(user).toMatch(/email\s+String\s+@unique/);
    expect(user).toMatch(/name\s+String\s+@index/);
    expect(user).toMatch(/joinedAt\s+Int\s+@index/);
    expect(user).toMatch(/tags\s+String\[\]/);
    expect(user).toMatch(/@@unique\(\[handle, tenant\]\)/);
    expect(user).toMatch(/FKM_FOLLOWS/);
    expect(text).toMatch(/since\s+Int\s+@index/);
  });

  it("applies a generated migration, records it, and reports drift against it", async () => {
    await cleanup();
    const v1 = resolveSchema(
      parseSchema(`node FkmDoc {
  id String @id
  title String @index
  embedding Vector(3)? @vectorIndex(similarity: cosine, name: "fkm_doc_vec")
}`),
    );
    const plan = diffSchemaModels(EMPTY_SCHEMA_MODEL, v1, { dialect: "falkordb" });
    const statements = plan.steps.flatMap((s) => (s.kind === "statement" ? [s.cypher] : []));
    const migration: LoadedMigration = {
      name: "fkm_init",
      checksum: "fkm",
      definition: {
        name: "fkm_init",
        async up({ db }) {
          for (const s of statements) await db.execute(s);
          await db.runInTransactionBatches({
            inner: "MATCH (d:FkmDoc) SET d.seen = true",
            batchSize: 10,
          });
        },
      },
    };
    expect(await runPendingMigrations(client, [migration])).toEqual(["fkm_init"]);
    expect(await runPendingMigrations(client, [migration])).toEqual([]);
    const applied = await client.withSession((s) => listAppliedMigrations(s));
    expect(applied.find((m) => m.name === "fkm_init")?.appliedAt).toBeInstanceOf(Date);

    const drift = async () => {
      const { objects, warnings } = await replayMigrations([migration]);
      expect(warnings).toEqual([]);
      return compareSchemaObjects(
        expectedSchemaForDialect(objects, "falkordb"),
        await readSchemaObjects(client),
      );
    };
    expect(await drift()).toEqual({ extra: [], missing: [], changed: [] });

    await run("DROP INDEX FOR (n:FkmDoc) ON (n.title)");
    await run("CREATE INDEX FOR (n:FkmDoc) ON (n.body)");
    await run("DROP VECTOR INDEX FOR (n:FkmDoc) ON (n.embedding)");
    await run(
      "CREATE VECTOR INDEX FOR (n:FkmDoc) ON (n.embedding) OPTIONS {dimension: 4, similarityFunction: 'euclidean'}",
    );
    const report = await drift();
    expect(report.extra.map((o) => [o.type, o.properties])).toEqual([["RANGE", ["body"]]]);
    expect(report.missing.map((o) => [o.type, o.properties])).toEqual([["RANGE", ["title"]]]);
    expect(report.changed.map((c) => c.differences)).toEqual([
      ["dimensions: 3 → 4", "similarity: cosine → euclidean"],
    ]);

    // The next migration drops by definition and recreates.
    await run("DROP INDEX FOR (n:FkmDoc) ON (n.body)");
    await run("DROP VECTOR INDEX FOR (n:FkmDoc) ON (n.embedding)");
    await run("CREATE INDEX FOR (n:FkmDoc) ON (n.title)");
    await run(
      "CREATE VECTOR INDEX FOR (n:FkmDoc) ON (n.embedding) OPTIONS {dimension: 3, similarityFunction: 'cosine'}",
    );
    const v2 = resolveSchema(
      parseSchema(`node FkmDoc {
  id String @id
  title String @unique
  embedding Vector(4)? @vectorIndex(similarity: cosine, name: "fkm_doc_vec")
}`),
    );
    const next = diffSchemaModels(v1, v2, { dialect: "falkordb" });
    await applyConstraintStatements(
      client,
      next.steps.flatMap((s) => (s.kind === "statement" ? [s.cypher] : [])),
    );
    expect(
      compareSchemaObjects(
        expectedSchemaFromModel(v2, "falkordb"),
        await readSchemaObjects(client),
      ),
    ).toEqual({ extra: [], missing: [], changed: [] });
  });

  it("renames a relationship type: the generated step moves the edges and their properties", async () => {
    await renameRelationshipTypeCase(client, "Fkm");
  });
});
