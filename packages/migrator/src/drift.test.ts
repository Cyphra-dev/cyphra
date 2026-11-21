import { parseSchema, resolveSchema } from "@cyphra/schema";
import { describe, expect, it } from "vitest";
import { ddlObjectsFromModel } from "./diff.js";
import {
  compareSchemaObjects,
  describeSchemaObject,
  expectedSchemaFromModel,
  expectedSchemaFromStatements,
  isDriftFree,
  parseDdlStatement,
  replayMigrations,
  schemaObjectsFromShow,
  type SchemaObject,
  type ShowRow,
} from "./drift.js";
import type { LoadedMigration } from "./runner.js";

const model = resolveSchema(
  parseSchema(`
  node User {
    id       String @id
    email    String @unique
    name     String @index
    location Point? @index
    tenant   String
    handle   String
    @@unique([tenant, handle])
    @@index([tenant, name])
  }
  node Doc {
    id        String @id
    title     String
    body      String
    embedding Vector(3)? @vectorIndex(similarity: cosine)
    @@fulltext([title, body], name: "docSearch", analyzer: "english")
  }
  relationship Follows { type "FOLLOWS"
    from User
    to User
    key   String @unique
    since Int    @index }
`),
);

/** The objects a database holds after `cyphra push` of {@link model}, as SHOW rows. */
function showRowsFor(objects: readonly SchemaObject[]): {
  constraints: ShowRow[];
  indexes: ShowRow[];
} {
  const constraints: ShowRow[] = [];
  const indexes: ShowRow[] = [
    { name: "index_343aff4e", type: "LOOKUP", entityType: "NODE", labelsOrTypes: null },
  ];
  for (const o of objects) {
    const base = {
      name: o.name,
      entityType: o.entityType,
      labelsOrTypes: [...o.labelsOrTypes],
      properties: [...o.properties],
    };
    if (o.kind === "constraint") {
      constraints.push({
        ...base,
        type: o.entityType === "NODE" ? "UNIQUENESS" : "RELATIONSHIP_UNIQUENESS",
      });
      indexes.push({ ...base, type: "RANGE", owningConstraint: o.name });
    } else {
      const indexConfig: Record<string, unknown> = {};
      if (o.type === "VECTOR") {
        indexConfig["vector.dimensions"] = o.options.dimensions;
        indexConfig["vector.similarity_function"] = String(o.options.similarity).toUpperCase();
        indexConfig["vector.quantization.enabled"] = true;
        indexConfig["vector.hnsw.m"] = 16;
      }
      if (o.type === "FULLTEXT") {
        indexConfig["fulltext.analyzer"] = o.options.analyzer;
        indexConfig["fulltext.eventually_consistent"] = false;
      }
      indexes.push({ ...base, type: o.type, owningConstraint: null, options: { indexConfig } });
    }
  }
  return { constraints, indexes };
}

const expected = expectedSchemaFromModel(model);
const actualOf = (rows: ReturnType<typeof showRowsFor>) =>
  schemaObjectsFromShow(rows.constraints, rows.indexes);
const byName = (name: string) => expected.find((o) => o.name === name)!;

describe("parseDdlStatement", () => {
  it("understands every statement Cyphra generates", () => {
    const ddl = ddlObjectsFromModel(model);
    expect(ddl.length).toBe(11);
    for (const o of ddl) {
      const parsed = parseDdlStatement(o.create);
      expect(parsed, o.create).toMatchObject({ op: "create", object: { name: o.name } });
    }
    expect(expected).toHaveLength(11);
  });

  it("normalizes each kind", () => {
    expect(byName("User_id_id")).toEqual({
      name: "User_id_id",
      kind: "constraint",
      type: "UNIQUE",
      entityType: "NODE",
      labelsOrTypes: ["User"],
      properties: ["id"],
      options: {},
    });
    expect(byName("User_location_idx")).toMatchObject({ type: "POINT", properties: ["location"] });
    expect(byName("User_tenant_handle_unique")).toMatchObject({
      kind: "constraint",
      properties: ["tenant", "handle"],
    });
    expect(byName("User_tenant_name_idx")).toMatchObject({
      type: "RANGE",
      properties: ["tenant", "name"],
    });
    expect(byName("Doc_embedding_vector")).toMatchObject({
      type: "VECTOR",
      options: { dimensions: 3, similarity: "cosine" },
    });
    expect(byName("docSearch")).toMatchObject({
      type: "FULLTEXT",
      properties: ["title", "body"],
      options: { analyzer: "english", eventuallyConsistent: false },
    });
    expect(byName("Follows_key_rel_unique")).toMatchObject({
      kind: "constraint",
      entityType: "RELATIONSHIP",
      labelsOrTypes: ["FOLLOWS"],
    });
    expect(byName("Follows_since_rel_idx")).toMatchObject({
      kind: "index",
      entityType: "RELATIONSHIP",
    });
  });

  it("parses hand-written forms", () => {
    expect(parseDdlStatement("CREATE INDEX FOR (p:Person) ON (p.age);")).toMatchObject({
      op: "create",
      ifNotExists: false,
      object: { name: null, type: "RANGE", labelsOrTypes: ["Person"], properties: ["age"] },
    });
    expect(
      parseDdlStatement(
        "create text index `my idx` if not exists for (n:`Odd Label`) on (n.`x y`)",
      ),
    ).toMatchObject({
      object: { name: "my idx", type: "TEXT", labelsOrTypes: ["Odd Label"], properties: ["x y"] },
    });
    expect(
      parseDdlStatement("CREATE CONSTRAINT k FOR (n:P) REQUIRE (n.a, n.b) IS NODE KEY"),
    ).toMatchObject({ object: { type: "KEY", properties: ["a", "b"] } });
    expect(
      parseDdlStatement("CREATE CONSTRAINT e FOR ()<-[r:R]-() REQUIRE r.at IS NOT NULL"),
    ).toMatchObject({ object: { type: "EXISTS", entityType: "RELATIONSHIP" } });
    expect(
      parseDdlStatement("CREATE CONSTRAINT t FOR (n:P) REQUIRE n.age IS :: INT"),
    ).toMatchObject({ object: { type: "TYPE", options: { propertyType: "INTEGER" } } });
    expect(parseDdlStatement("CREATE FULLTEXT INDEX f FOR (n:B|A) ON EACH [n.t]")).toMatchObject({
      object: {
        labelsOrTypes: ["A", "B"],
        options: { analyzer: "standard-no-stop-words", eventuallyConsistent: false },
      },
    });
    expect(
      parseDdlStatement(
        "CREATE VECTOR INDEX v FOR (n:D) ON n.e OPTIONS {indexConfig: {`vector.dimensions`: 8, `vector.similarity_function`: 'EUCLIDEAN', `vector.quantization.enabled`: false}}",
      ),
    ).toMatchObject({
      object: { options: { dimensions: 8, similarity: "euclidean", quantization: false } },
    });
    expect(parseDdlStatement("DROP INDEX `old` IF EXISTS")).toEqual({
      op: "drop",
      kind: "index",
      name: "old",
    });
  });

  it("ignores data statements and flags DDL it cannot read", () => {
    expect(parseDdlStatement("MATCH (n:User) WHERE n.role IS NULL SET n.role = $value")).toBe(null);
    expect(parseDdlStatement("CREATE (:Index {name: 'x'})")).toBe(null);
    expect(parseDdlStatement("CREATE INDEX i FOR (n:P) ON (n.a + 1)")).toMatchObject({
      op: "unsupported",
    });
  });
});

describe("expectedSchemaFromStatements", () => {
  it("replays creates and drops in order", () => {
    const { objects, warnings } = expectedSchemaFromStatements([
      "CREATE RANGE INDEX a IF NOT EXISTS FOR (n:P) ON (n.a)",
      "CREATE RANGE INDEX b IF NOT EXISTS FOR (n:P) ON (n.b)",
      "MATCH (n:P) SET n.a = 1",
      "DROP INDEX a IF EXISTS",
      // IF NOT EXISTS keeps the existing definition…
      "CREATE POINT INDEX b IF NOT EXISTS FOR (n:P) ON (n.b)",
      // …and is a no-op when an equivalent index exists under another name.
      "CREATE RANGE INDEX b2 IF NOT EXISTS FOR (n:P) ON (n.b)",
      "CREATE CONSTRAINT cyphra_migration_name_unique IF NOT EXISTS FOR (m:__CyphraMigration) REQUIRE m.name IS UNIQUE",
      "CREATE INDEX weird FOR (n:P) ON (n.a + 1)",
    ]);
    expect(objects.map((o) => [o.name, o.type])).toEqual([["b", "RANGE"]]);
    expect(warnings).toEqual([expect.stringContaining("Could not interpret DDL")]);
  });
});

describe("replayMigrations", () => {
  const migration = (name: string, up: LoadedMigration["definition"]["up"]): LoadedMigration => ({
    name,
    checksum: "x",
    definition: { name, up },
  });

  it("records DDL from execute and run, without touching a database", async () => {
    const { objects, warnings } = await replayMigrations([
      migration("1", async ({ db }) => {
        await db.execute("CREATE CONSTRAINT u IF NOT EXISTS FOR (n:U) REQUIRE n.id IS UNIQUE");
        const [row] = await db.execute("MATCH (n:U) WHERE n.x IS NULL RETURN count(n) AS count");
        if (row && Number(row.count) > 0) throw new Error("guard");
        await db.run`CREATE INDEX i IF NOT EXISTS FOR (n:U) ON (n.name)`;
        await db.migrate.renameLabel({ from: "A", to: "B" });
      }),
      migration("2", async ({ db }) => {
        await db.execute("DROP INDEX i IF EXISTS");
        await db.execute("CREATE TEXT INDEX i IF NOT EXISTS FOR (n:U) ON (n.name)");
      }),
      migration("3", async ({ db }) => {
        await db.execute("CREATE INDEX j IF NOT EXISTS FOR (n:U) ON (n.j)");
        throw new Error("boom");
      }),
    ]);
    expect(objects.map((o) => `${o.name}:${o.type}`)).toEqual(["u:UNIQUE", "i:TEXT", "j:RANGE"]);
    expect(warnings).toEqual([expect.stringMatching(/Migration 3 could not be replayed \(boom\)/)]);
  });
});

describe("schemaObjectsFromShow", () => {
  it("skips lookup indexes, constraint-owned indexes and Cyphra bookkeeping", () => {
    const rows = showRowsFor(expected);
    rows.constraints.push({
      name: "cyphra_migration_name_unique",
      type: "UNIQUENESS",
      entityType: "NODE",
      labelsOrTypes: ["__CyphraMigration"],
      properties: ["name"],
    });
    const actual = actualOf(rows);
    expect(actual).toHaveLength(expected.length);
    expect(actual.find((o) => o.name === "Doc_embedding_vector")!.options).toEqual({
      dimensions: 3,
      similarity: "cosine",
      quantization: true,
    });
  });
});

describe("compareSchemaObjects", () => {
  it("is in sync when the database matches", () => {
    const report = compareSchemaObjects(expected, actualOf(showRowsFor(expected)));
    expect(isDriftFree(report)).toBe(true);
  });

  it("reports extra and missing objects of every kind", () => {
    const db = expected.filter((o) => o.name !== "User_email_unique" && o.name !== "docSearch");
    const rows = showRowsFor(db);
    rows.indexes.push({
      name: "manual_idx",
      type: "TEXT",
      entityType: "NODE",
      labelsOrTypes: ["User"],
      properties: ["bio"],
      owningConstraint: null,
    });
    const report = compareSchemaObjects(expected, actualOf(rows));
    expect(report.missing.map((o) => o.name)).toEqual(["User_email_unique", "docSearch"]);
    expect(report.extra.map((o) => o.name)).toEqual(["manual_idx"]);
    expect(report.changed).toEqual([]);
  });

  const change = (name: string, patch: Partial<SchemaObject>) => {
    const db = expected.map((o) => (o.name === name ? { ...o, ...patch } : o));
    const report = compareSchemaObjects(expected, actualOf(showRowsFor(db)));
    expect(report.extra).toEqual([]);
    expect(report.missing).toEqual([]);
    expect(report.changed).toHaveLength(1);
    return report.changed[0]!.differences;
  };

  it("reports vector dimension and similarity changes", () => {
    expect(
      change("Doc_embedding_vector", {
        options: { dimensions: 4, similarity: "euclidean" },
      }),
    ).toEqual(["dimensions: 3 → 4", "similarity: cosine → euclidean"]);
  });

  it("reports full-text analyzer and field changes", () => {
    expect(change("docSearch", { options: { analyzer: "standard" } })).toEqual([
      "analyzer: english → standard",
    ]);
    expect(change("docSearch", { properties: ["title"] })).toEqual([
      "properties: title, body → title",
    ]);
  });

  it("reports an index type change", () => {
    expect(change("User_location_idx", { type: "RANGE" })).toEqual(["type: POINT → RANGE"]);
  });

  it("reports changed fields of a composite constraint and of a relationship index", () => {
    expect(change("User_tenant_handle_unique", { properties: ["handle", "tenant"] })).toEqual([
      "properties: tenant, handle → handle, tenant",
    ]);
    expect(change("Follows_since_rel_idx", { labelsOrTypes: ["LIKES"] })).toEqual([
      "relationship types: FOLLOWS → LIKES",
    ]);
  });

  it("matches unnamed and renamed objects by definition", () => {
    const { objects } = expectedSchemaFromStatements([
      "CREATE INDEX FOR (n:P) ON (n.a)",
      "CREATE INDEX named FOR (n:P) ON (n.b)",
    ]);
    const actual = schemaObjectsFromShow(
      [],
      [
        {
          name: "index_1234",
          type: "RANGE",
          entityType: "NODE",
          labelsOrTypes: ["P"],
          properties: ["a"],
        },
        {
          name: "other",
          type: "RANGE",
          entityType: "NODE",
          labelsOrTypes: ["P"],
          properties: ["b"],
        },
      ],
    );
    const report = compareSchemaObjects(objects, actual);
    expect(report.extra).toEqual([]);
    expect(report.missing).toEqual([]);
    expect(report.changed.map((c) => c.differences)).toEqual([["name: named → other"]]);
  });

  it("describes objects on one line", () => {
    expect(describeSchemaObject(byName("Doc_embedding_vector"))).toBe(
      "VECTOR index on (:Doc {embedding}) dimensions=3 similarity=cosine",
    );
    expect(describeSchemaObject(byName("Follows_key_rel_unique"))).toBe(
      "UNIQUE constraint on ()-[:FOLLOWS {key}]-()",
    );
  });
});
