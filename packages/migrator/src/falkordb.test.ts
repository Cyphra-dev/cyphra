import { describe, expect, it } from "vitest";
import { parseSchema, resolveSchema } from "@cyphra/schema";
import { UnsupportedFeatureError } from "@cyphra/runtime";
import { ddlForDialect } from "./memgraph.js";
import {
  falkordbDdl,
  falkordbExecutable,
  falkordbSchemaObjects,
  isFalkorDBDdl,
  normalizeFalkorDBObjects,
  parseFalkorDBDdl,
  runFalkorDBDdl,
} from "./falkordb.js";
import { EMPTY_SCHEMA_MODEL, diffSchemaModels } from "./diff.js";
import {
  compareSchemaObjects,
  expectedSchemaFromModel,
  expectedSchemaFromStatements,
  parseDdlStatement,
} from "./drift.js";
import { wrapInTransactions } from "./batch.js";
import {
  constraintStatementsFromSchema,
  fulltextIndexStatementsFromSchema,
  indexStatementsFromSchema,
  vectorIndexStatementsFromSchema,
} from "./push.js";

const SCHEMA = `
node FkUser {
  id       String  @id
  email    String  @unique
  name     String  @index
  tenant   String
  handle   String
  joinedAt Int
  embedding Vector(3)? @vectorIndex(similarity: cosine)
  sketch    Vector(2)? @vectorIndex(similarity: euclidean, name: "fk_sketch")
  follows  FkUser[] @relationship(type: "FK_FOLLOWS", direction: OUT)
  @@unique([tenant, handle])
  @@index([tenant, joinedAt])
  @@fulltext([name, handle], name: "fkUserSearch")
}

relationship FkFollows {
  type "FK_FOLLOWS"
  from FkUser
  to   FkUser
  since Int @index
  key String? @unique
}
`;

const pushed = () => {
  const doc = parseSchema(SCHEMA);
  return [
    ...constraintStatementsFromSchema(doc),
    ...indexStatementsFromSchema(doc),
    ...vectorIndexStatementsFromSchema(doc),
    ...fulltextIndexStatementsFromSchema(doc),
  ];
};

describe("FalkorDB DDL", () => {
  it("translates every statement push writes", () => {
    expect(ddlForDialect(pushed(), "falkordb")).toEqual([
      "GRAPH.CONSTRAINT CREATE UNIQUE NODE `FkUser` PROPERTIES 1 `id`",
      "GRAPH.CONSTRAINT CREATE UNIQUE NODE `FkUser` PROPERTIES 1 `email`",
      "GRAPH.CONSTRAINT CREATE UNIQUE RELATIONSHIP `FK_FOLLOWS` PROPERTIES 1 `key`",
      "GRAPH.CONSTRAINT CREATE UNIQUE NODE `FkUser` PROPERTIES 2 `tenant` `handle`",
      "CREATE INDEX FOR (n:`FkUser`) ON (n.`name`)",
      "CREATE INDEX FOR ()-[r:`FK_FOLLOWS`]-() ON (r.`since`)",
      "CREATE INDEX FOR (n:`FkUser`) ON (n.`tenant`, n.`joinedAt`)",
      "CREATE VECTOR INDEX FOR (n:`FkUser`) ON (n.`embedding`) OPTIONS {dimension: 3, similarityFunction: 'cosine'}",
      "CREATE VECTOR INDEX FOR (n:`FkUser`) ON (n.`sketch`) OPTIONS {dimension: 2, similarityFunction: 'euclidean'}",
      "CREATE FULLTEXT INDEX FOR (n:`FkUser`) ON (n.`name`, n.`handle`)",
    ]);
    // Statements already in FalkorDB's syntax, and data statements, are kept.
    expect(ddlForDialect(["MATCH (n) RETURN n"], "falkordb")).toEqual(["MATCH (n) RETURN n"]);
    expect(falkordbDdl("GRAPH.CONSTRAINT CREATE UNIQUE NODE `A` PROPERTIES 1 `x`")).toBeNull();
  });

  it("leaves Neo4j and Memgraph output unchanged", () => {
    expect(ddlForDialect(pushed(), "neo4j")).toEqual(pushed());
  });

  it("gives each object the statement that drops it by definition", () => {
    expect(
      falkordbDdl("CREATE CONSTRAINT x IF NOT EXISTS FOR (n:`A`) REQUIRE n.`p` IS NOT NULL"),
    ).toEqual({
      create: "GRAPH.CONSTRAINT CREATE MANDATORY NODE `A` PROPERTIES 1 `p`",
      drop: "GRAPH.CONSTRAINT DROP MANDATORY NODE `A` PROPERTIES 1 `p`",
    });
    expect(falkordbDdl("CREATE FULLTEXT INDEX s IF NOT EXISTS FOR (n:A) ON EACH [n.a]")).toEqual({
      create: "CREATE FULLTEXT INDEX FOR (n:`A`) ON (n.`a`)",
      drop: "DROP FULLTEXT INDEX FOR (n:`A`) ON (n.`a`)",
    });
  });

  it("refuses what FalkorDB has no equivalent of", () => {
    expect(() => falkordbDdl("CREATE POINT INDEX p IF NOT EXISTS FOR (n:A) ON (n.loc)")).toThrow(
      UnsupportedFeatureError,
    );
    expect(() =>
      falkordbDdl("CREATE CONSTRAINT t IF NOT EXISTS FOR (n:A) REQUIRE n.p IS :: INTEGER"),
    ).toThrow(/property type constraint .* not supported on FalkorDB/);
    expect(() => falkordbDdl("CREATE INDEX i IF NOT EXISTS FOR (n:A|B) ON (n.p)")).toThrow(
      UnsupportedFeatureError,
    );
  });

  it("plans migrations with FalkorDB DDL, dropping objects by definition", () => {
    const next = resolveSchema(parseSchema(SCHEMA));
    const plan = diffSchemaModels(EMPTY_SCHEMA_MODEL, next, { dialect: "falkordb" });
    const cypher = plan.steps.map((s) => (s.kind === "statement" ? s.cypher : ""));
    expect(cypher).toContain("GRAPH.CONSTRAINT CREATE UNIQUE NODE `FkUser` PROPERTIES 1 `email`");
    const back = diffSchemaModels(next, EMPTY_SCHEMA_MODEL, { dialect: "falkordb" });
    expect(back.steps.map((s) => (s.kind === "statement" ? s.cypher : ""))).toContain(
      "DROP INDEX FOR (n:`FkUser`) ON (n.`name`)",
    );
  });

  it("backfills temporal defaults as the ISO text the ORM stores", () => {
    const prev = resolveSchema(parseSchema("node FkEv {\n  id String @id\n}\n"));
    const next = resolveSchema(
      parseSchema(
        'node FkEv {\n  id String @id\n  at DateTime @default(now())\n  slot LocalTime @default("09:30:00")\n}\n',
      ),
    );
    const steps = diffSchemaModels(prev, next, { dialect: "falkordb" }).steps;
    const text = steps.map((s) => (s.kind === "statement" ? s.cypher : "")).join("\n");
    expect(text).toContain("SET n.`at` = toString(localdatetime()) + '.000Z'");
    expect(text).toContain("SET n.`slot` = $value");
    expect(steps.find((s) => s.kind === "statement" && s.cypher.includes("slot"))).toMatchObject({
      params: { value: expect.stringMatching(/^09:30/) },
    });
    const neo = diffSchemaModels(prev, next).steps;
    expect(neo.map((s) => (s.kind === "statement" ? s.cypher : "")).join("\n")).toContain(
      "SET n.`at` = datetime()",
    );
  });

  it("splits composite range indexes when running them", () => {
    expect(falkordbExecutable("CREATE INDEX FOR (n:`A`) ON (n.`a`, n.`b`)")).toEqual([
      "CREATE INDEX FOR (n:`A`) ON (n.`a`)",
      "CREATE INDEX FOR (n:`A`) ON (n.`b`)",
    ]);
    expect(falkordbExecutable("DROP INDEX FOR (n:`A`) ON (n.`a`, n.`b`)")).toEqual([
      "DROP INDEX FOR (n:`A`) ON (n.`a`)",
      "DROP INDEX FOR (n:`A`) ON (n.`b`)",
    ]);
    expect(falkordbExecutable("MATCH (n) RETURN n")).toEqual(["MATCH (n) RETURN n"]);
  });

  it("runs DDL with IF [NOT] EXISTS semantics", async () => {
    const ran: string[] = [];
    const run = async (text: string) => {
      ran.push(text);
      if (text.includes("`a`")) throw new Error("Attribute 'a' is already indexed");
      if (text.startsWith("DROP"))
        throw new Error("ERR Unable to drop index on :A(z): no such index.");
    };
    await runFalkorDBDdl(run, "CREATE INDEX FOR (n:`A`) ON (n.`a`, n.`b`)");
    await runFalkorDBDdl(run, "DROP INDEX FOR (n:`A`) ON (n.`z`)");
    expect(ran).toHaveLength(3);
    await expect(
      runFalkorDBDdl(async () => {
        throw new Error("boom");
      }, "CREATE INDEX FOR (n:`A`) ON (n.`b`)"),
    ).rejects.toThrow("boom");
    // Data statements keep their errors.
    await expect(
      runFalkorDBDdl(async () => {
        throw new Error("already exists");
      }, "MATCH (n) RETURN n"),
    ).rejects.toThrow("already exists");
  });

  it("parses FalkorDB DDL into the objects drift detection compares", () => {
    expect(isFalkorDBDdl("CREATE INDEX FOR (n:A) ON (n.a)")).toBe(true);
    expect(isFalkorDBDdl("CREATE FULLTEXT INDEX x IF NOT EXISTS FOR (n:A) ON EACH [n.a]")).toBe(
      false,
    );
    expect(parseFalkorDBDdl("GRAPH.CONSTRAINT DROP UNIQUE NODE `A` PROPERTIES 2 `a` `b`")).toEqual({
      op: "drop",
      object: {
        name: null,
        kind: "constraint",
        type: "UNIQUE",
        entityType: "NODE",
        labelsOrTypes: ["A"],
        properties: ["a", "b"],
        options: {},
      },
    });
    expect(
      parseDdlStatement(
        "CREATE VECTOR INDEX FOR (n:`A`) ON (n.`e`) OPTIONS {dimension: 3, similarityFunction: 'euclidean'}",
      ),
    ).toMatchObject({
      op: "create",
      object: { type: "VECTOR", options: { dimensions: 3, similarity: "euclidean" } },
    });
    expect(parseDdlStatement("DROP INDEX FOR ()-[r:`T`]-() ON (r.`p`)")).toMatchObject({
      op: "dropDefinition",
      object: { type: "RANGE", entityType: "RELATIONSHIP", labelsOrTypes: ["T"] },
    });
    // Replaying FalkorDB DDL: created, then dropped by definition.
    const { objects } = expectedSchemaFromStatements([
      "CREATE FULLTEXT INDEX FOR (n:`A`) ON (n.`b`, n.`a`)",
      "GRAPH.CONSTRAINT CREATE UNIQUE NODE `A` PROPERTIES 1 `x`",
      "GRAPH.CONSTRAINT DROP UNIQUE NODE `A` PROPERTIES 1 `x`",
    ]);
    expect(objects).toEqual([
      expect.objectContaining({ type: "FULLTEXT", properties: ["a", "b"] }),
    ]);
  });

  it("reads db.constraints() / db.indexes() rows and compares them with the schema", () => {
    const model = resolveSchema(parseSchema(SCHEMA));
    const actual = normalizeFalkorDBObjects(
      falkordbSchemaObjects(
        [
          { type: "UNIQUE", label: "FkUser", properties: ["id"], entitytype: "NODE" },
          { type: "UNIQUE", label: "FkUser", properties: ["email"], entitytype: "NODE" },
          { type: "UNIQUE", label: "FkUser", properties: ["handle", "tenant"], entitytype: "NODE" },
          { type: "UNIQUE", label: "FK_FOLLOWS", properties: ["key"], entitytype: "RELATIONSHIP" },
        ],
        [
          {
            label: "FkUser",
            properties: [
              "id",
              "email",
              "name",
              "tenant",
              "handle",
              "joinedAt",
              "embedding",
              "sketch",
            ],
            types: {
              id: ["RANGE"],
              email: ["RANGE"],
              name: ["RANGE", "FULLTEXT"],
              tenant: ["RANGE"],
              handle: ["RANGE", "FULLTEXT"],
              joinedAt: ["RANGE"],
              embedding: ["VECTOR"],
              sketch: ["VECTOR"],
            },
            options: {
              embedding: { dimension: 3, similarityFunction: "cosine", M: 16 },
              sketch: { dimension: 2, similarityFunction: "euclidean" },
            },
            entitytype: "NODE",
          },
          {
            label: "FK_FOLLOWS",
            properties: ["key", "since"],
            types: { key: ["RANGE"], since: ["RANGE"] },
            options: {},
            entitytype: "RELATIONSHIP",
          },
        ],
      ),
    );
    const report = compareSchemaObjects(expectedSchemaFromModel(model, "falkordb"), actual);
    expect(report).toEqual({ extra: [], missing: [], changed: [] });
    // A changed vector dimension is reported.
    const changed = actual.map((o) =>
      o.type === "VECTOR" && o.properties[0] === "embedding"
        ? { ...o, options: { ...o.options, dimensions: 4 } }
        : o,
    );
    const drift = compareSchemaObjects(expectedSchemaFromModel(model, "falkordb"), changed);
    expect(drift.missing.length + drift.changed.length).toBeGreaterThan(0);
  });

  it("runs batched statements as one statement", () => {
    expect(wrapInTransactions("  MATCH (n) SET n.x = 1 ", 100, "falkordb")).toBe(
      "MATCH (n) SET n.x = 1",
    );
    expect(() => wrapInTransactions("MATCH (n) RETURN n", 0, "falkordb")).toThrow();
  });
});
