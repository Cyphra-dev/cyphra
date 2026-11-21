import { describe, expect, it } from "vitest";
import { parseSchema, resolveSchema } from "@cyphra/schema";
import { UnsupportedFeatureError } from "@cyphra/runtime";
import {
  ddlForDialect,
  isMemgraphDdl,
  memgraphDdl,
  memgraphSchemaObjects,
  parseMemgraphDdl,
} from "./memgraph.js";
import { EMPTY_SCHEMA_MODEL, ddlObjectsFromModel, diffSchemaModels } from "./diff.js";
import {
  compareSchemaObjects,
  expectedSchemaFromModel,
  expectedSchemaFromStatements,
  parseDdlStatement,
} from "./drift.js";
import {
  constraintStatementsFromSchema,
  fulltextIndexStatementsFromSchema,
  indexStatementsFromSchema,
  vectorIndexStatementsFromSchema,
} from "./push.js";

const SCHEMA = `
node MgUser {
  id       String  @id
  email    String  @unique
  name     String  @index
  location Point?  @index
  tenant   String
  handle   String
  joinedAt Int
  embedding Vector(3)? @vectorIndex(similarity: cosine)
  sketch    Vector(2)? @vectorIndex(similarity: euclidean, name: "mg_sketch")
  follows  MgUser[] @relationship(type: "MG_FOLLOWS", direction: OUT)

  @@unique([tenant, handle])
  @@index([tenant, joinedAt])
  @@fulltext([name, handle], name: "mgUserSearch", analyzer: "english")
}

relationship MgFollows {
  type "MG_FOLLOWS"
  from MgUser
  to   MgUser
  since Int @index
}
`;

describe("Memgraph DDL", () => {
  it("translates every statement push writes", () => {
    const doc = parseSchema(SCHEMA);
    const statements = [
      ...constraintStatementsFromSchema(doc),
      ...indexStatementsFromSchema(doc),
      ...vectorIndexStatementsFromSchema(doc),
      ...fulltextIndexStatementsFromSchema(doc),
    ];
    expect(ddlForDialect(statements, "memgraph")).toEqual([
      "CREATE CONSTRAINT ON (n:`MgUser`) ASSERT n.`id` IS UNIQUE",
      "CREATE CONSTRAINT ON (n:`MgUser`) ASSERT n.`email` IS UNIQUE",
      "CREATE CONSTRAINT ON (n:`MgUser`) ASSERT n.`tenant`, n.`handle` IS UNIQUE",
      "CREATE INDEX ON :`MgUser`(`name`)",
      "CREATE POINT INDEX ON :`MgUser`(`location`)",
      "CREATE EDGE INDEX ON :`MG_FOLLOWS`(`since`)",
      "CREATE INDEX ON :`MgUser`(`tenant`, `joinedAt`)",
      'CREATE VECTOR INDEX `MgUser_embedding_vector` ON :`MgUser`(`embedding`) WITH CONFIG {"dimension": 3, "capacity": 1000, "metric": "cos"}',
      'CREATE VECTOR INDEX `mg_sketch` ON :`MgUser`(`sketch`) WITH CONFIG {"dimension": 2, "capacity": 1000, "metric": "l2sq"}',
      "CREATE TEXT INDEX `mgUserSearch` ON :`MgUser`(`name`, `handle`)",
    ]);
    // Neo4j statements are left as they are.
    expect(ddlForDialect(statements, "neo4j")).toEqual(statements);
  });

  it("gives each object the statement that drops it by definition", () => {
    expect(
      memgraphDdl("CREATE CONSTRAINT A_b_unique IF NOT EXISTS FOR (n:`A`) REQUIRE n.`b` IS UNIQUE"),
    ).toEqual({
      create: "CREATE CONSTRAINT ON (n:`A`) ASSERT n.`b` IS UNIQUE",
      drop: "DROP CONSTRAINT ON (n:`A`) ASSERT n.`b` IS UNIQUE",
    });
    expect(
      memgraphDdl("CREATE RANGE INDEX A_b_idx IF NOT EXISTS FOR (n:`A`) ON (n.`b`)")?.drop,
    ).toBe("DROP INDEX ON :`A`(`b`)");
    expect(
      memgraphDdl("CREATE POINT INDEX A_p_idx IF NOT EXISTS FOR (n:`A`) ON (n.`p`)")?.drop,
    ).toBe("DROP POINT INDEX ON :`A`(`p`)");
    expect(
      memgraphDdl("CREATE RANGE INDEX R_w_rel_idx IF NOT EXISTS FOR ()-[r:`R`]-() ON (r.`w`)")
        ?.drop,
    ).toBe("DROP EDGE INDEX ON :`R`(`w`)");
    expect(
      memgraphDdl("CREATE FULLTEXT INDEX s IF NOT EXISTS FOR (n:`A`) ON EACH [n.`t`]")?.drop,
    ).toBe("DROP TEXT INDEX `s`");
    // Data statements and Memgraph DDL are not touched.
    expect(memgraphDdl("MATCH (n) SET n.x = 1")).toBeNull();
    expect(memgraphDdl("CREATE INDEX ON :A(b)")).toBeNull();
    expect(isMemgraphDdl("CREATE TEXT INDEX s ON :A(t)")).toBe(true);
    expect(isMemgraphDdl("CREATE TEXT INDEX s IF NOT EXISTS FOR (n:A) ON (n.t)")).toBe(false);
  });

  it("refuses what Memgraph has no equivalent of", () => {
    const rel = () =>
      memgraphDdl(
        "CREATE CONSTRAINT L_ref_rel_unique IF NOT EXISTS FOR ()-[r:`LINK`]-() REQUIRE r.`ref` IS UNIQUE",
      );
    expect(rel).toThrow(UnsupportedFeatureError);
    expect(rel).toThrow(
      /A uniqueness constraint on relationships \(\)-\[:LINK \{ref\}\]-\(\) is not supported on Memgraph/,
    );
    expect(() =>
      ddlObjectsFromModel(
        resolveSchema(
          parseSchema(`node A { id String @id
  links A[] @relationship(type: "L", direction: OUT) }
relationship L { type "L"
  from A
  to A
  ref String @unique }`),
        ),
        { dialect: "memgraph" },
      ),
    ).toThrow(UnsupportedFeatureError);
  });

  it("plans migrations with Memgraph DDL, dropping objects by definition", () => {
    const v1 = resolveSchema(parseSchema(`node A { id String @id\n b String @index }`));
    const v2 = resolveSchema(parseSchema(`node A { id String @id\n b String @unique }`));
    expect(
      diffSchemaModels(EMPTY_SCHEMA_MODEL, v1, { dialect: "memgraph" }).steps.map((s) =>
        s.kind === "statement" ? s.cypher : s.kind,
      ),
    ).toEqual([
      "CREATE CONSTRAINT ON (n:`A`) ASSERT n.`id` IS UNIQUE",
      "CREATE INDEX ON :`A`(`b`)",
    ]);
    expect(
      diffSchemaModels(v1, v2, { dialect: "memgraph" }).steps.map((s) =>
        s.kind === "statement" ? s.cypher : s.kind,
      ),
    ).toEqual(["DROP INDEX ON :`A`(`b`)", "CREATE CONSTRAINT ON (n:`A`) ASSERT n.`b` IS UNIQUE"]);
    // Neo4j plans are unchanged.
    expect(diffSchemaModels(v1, v2).steps[0]).toMatchObject({
      cypher: "DROP INDEX A_b_idx IF EXISTS",
    });
  });

  it("parses Memgraph DDL into the objects drift detection compares", () => {
    expect(parseMemgraphDdl("CREATE CONSTRAINT ON (n:`A`) ASSERT n.`z`, n.a IS UNIQUE")).toEqual({
      op: "create",
      object: {
        name: null,
        kind: "constraint",
        type: "UNIQUE",
        entityType: "NODE",
        labelsOrTypes: ["A"],
        properties: ["a", "z"],
        options: {},
      },
    });
    expect(parseMemgraphDdl("DROP EDGE INDEX ON :R(w)")?.object).toMatchObject({
      type: "RANGE",
      entityType: "RELATIONSHIP",
      labelsOrTypes: ["R"],
      properties: ["w"],
    });
    expect(
      parseMemgraphDdl(
        'CREATE VECTOR INDEX `v` ON :A(e) WITH CONFIG {"dimension": 4, "capacity": 1000, "metric": "l2sq"}',
      )?.object,
    ).toMatchObject({
      name: "v",
      type: "VECTOR",
      options: { dimensions: 4, similarity: "euclidean" },
    });
    expect(parseDdlStatement("DROP TEXT INDEX s")).toEqual({
      op: "drop",
      kind: "index",
      name: "s",
    });
    expect(parseDdlStatement("DROP INDEX ON :A(b)")).toMatchObject({ op: "dropDefinition" });

    const { objects, warnings } = expectedSchemaFromStatements([
      "CREATE INDEX ON :A(b)",
      "CREATE CONSTRAINT ON (n:A) ASSERT n.id IS UNIQUE",
      "CREATE INDEX ON :A(b)",
      "DROP INDEX ON :A(b)",
    ]);
    expect(warnings).toEqual([]);
    expect(objects.map((o) => [o.kind, o.type, o.properties])).toEqual([
      ["constraint", "UNIQUE", ["id"]],
    ]);
  });

  it("reads SHOW … INFO rows and compares them with the schema", () => {
    const model = resolveSchema(parseSchema(SCHEMA.replace(/since Int @index/, "since Int")));
    const actual = memgraphSchemaObjects(
      [
        { "constraint type": "unique", label: "MgUser", properties: ["id"], data_type: "" },
        { "constraint type": "unique", label: "MgUser", properties: ["email"], data_type: "" },
        // Memgraph lists a composite constraint's properties in no stable order.
        {
          "constraint type": "unique",
          label: "MgUser",
          properties: ["handle", "tenant"],
          data_type: "",
        },
      ],
      [
        { "index type": "label+property", label: "MgUser", property: ["name"], count: 0 },
        { "index type": "point", label: "MgUser", property: "location", count: 0 },
        {
          "index type": "label+property",
          label: "MgUser",
          property: ["tenant", "joinedAt"],
          count: 0,
        },
        { "index type": "label+property_vector", label: ":MgUser", property: "embedding" },
        { "index type": "label+property_vector", label: ":MgUser", property: "sketch" },
        {
          "index type": "label_text (name: mgUserSearch)",
          label: "MgUser",
          property: ["name", "handle"],
        },
        { "index type": "label", label: "MgUser", property: null },
      ],
      [
        {
          index_name: "MgUser_embedding_vector",
          label: ":MgUser",
          property: "embedding",
          dimension: 3,
          metric: "cos",
        },
        {
          index_name: "mg_sketch",
          label: ":MgUser",
          property: "sketch",
          dimension: 5,
          metric: "cos",
        },
      ],
    );
    const report = compareSchemaObjects(expectedSchemaFromModel(model, "memgraph"), actual);
    expect(report.missing).toEqual([]);
    expect(report.extra.map((o) => o.type)).toEqual(["LABEL"]);
    expect(report.changed.map((c) => [c.expected.name, c.differences])).toEqual([
      ["mg_sketch", ["dimensions: 2 → 5", "similarity: euclidean → cosine"]],
    ]);
  });
});
