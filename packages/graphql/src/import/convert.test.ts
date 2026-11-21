import { parseSchema, printSchemaDocument, resolveSchema, validateSchema } from "@cyphra/schema";
import type { NodeDeclaration } from "@cyphra/schema";
import { describe, expect, it } from "vitest";
import { GraphQLImportError, convertGraphQLTypeDefs } from "./convert.js";
import type { ImportIssue } from "./mappings.js";

/** Convert, check the result resolves, and return the printed schema body and the issues. */
function convert(sdl: string): { schema: string; issues: readonly ImportIssue[] } {
  const result = convertGraphQLTypeDefs(sdl);
  const schema = printSchemaDocument(result.document);
  resolveSchema(parseSchema(schema));
  return { schema, issues: result.issues };
}

function issueAt(issues: readonly ImportIssue[], at: string): ImportIssue | undefined {
  return issues.find((i) => i.at === at);
}

describe("convertGraphQLTypeDefs: types", () => {
  it("maps scalars, nullability and lists", () => {
    const { schema, issues } = convert(`
      type T @node {
        a: ID!
        b: String
        c: Int!
        d: Float
        e: Boolean!
        f: DateTime
        g: Date!
        h: [String!]!
        i: [Int]
      }
    `);
    expect(schema).toBe(`node T {
  a String
  b String?
  c Int
  d Float?
  e Boolean
  f DateTime?
  g Date
  h String[]
  i Int[]
}
`);
    expect(issues).toEqual([]);
  });

  it.each(["Time", "LocalTime", "LocalDateTime", "Duration", "Point", "CartesianPoint"])(
    "reports %s as not converted and drops the field",
    (scalar) => {
      const result = convertGraphQLTypeDefs(`type T @node { name: String!, x: ${scalar} }`);
      const node = result.document.declarations[0] as NodeDeclaration;
      expect(node.fields.map((f) => f.name)).toEqual(["name"]);
      expect(issueAt(result.issues, "T.x")).toMatchObject({
        severity: "unsupported",
        feature: scalar,
      });
      expect(result.notes.get("T")).toEqual([`x: ${scalar} (not converted: type not supported)`]);
    },
  );

  it("maps enums to Cyphra enums (only the ones converted fields use)", () => {
    const { schema, issues } = convert(`
      enum Genre { DRAMA COMEDY }
      enum SortDirection { ASC DESC }
      extend enum Genre { HORROR }
      type Movie @node { genre: Genre!, genres: [Genre!]!, maybe: Genre }
    `);
    expect(schema).toContain("enum Genre {\n  DRAMA\n  COMEDY\n  HORROR\n}\n");
    expect(schema).not.toContain("SortDirection");
    expect(schema).toContain("genre Genre\n");
    expect(schema).toContain("genres Genre[]\n");
    expect(schema).toContain("maybe Genre?\n");
    expect(issues).toEqual([]);
    expect(() => resolveSchema(parseSchema(schema))).not.toThrow();
  });

  it("maps an enum whose name Cyphra cannot use to String", () => {
    const { schema, issues } = convert(`
      enum Json { A B }
      type T @node { j: Json }
    `);
    expect(schema).toContain("j String?\n");
    expect(issueAt(issues, "Json")).toMatchObject({ severity: "changed", feature: "enum" });
  });

  it("maps BigInt to BigInt, with exact defaults", () => {
    const { schema, issues } = convert(`
      type T @node {
        a: BigInt!
        b: [BigInt!]!
        c: BigInt @default(value: "9223372036854775807")
        d: BigInt! @default(value: 0)
      }
    `);
    expect(schema).toContain("a BigInt\n");
    expect(schema).toContain("b BigInt[]\n");
    expect(schema).toContain("c BigInt? @default(9223372036854775807)\n");
    expect(schema).toContain("d BigInt @default(0)\n");
    expect(issues).toEqual([]);
    const model = resolveSchema(parseSchema(schema));
    expect(model.nodes[0]!.fields[2]).toMatchObject({
      default: { kind: "literal", value: "9223372036854775807" },
    });
  });

  it("reports custom scalars and drops their fields", () => {
    const { schema, issues } = convert(`scalar JSON
      type T @node { name: String, data: JSON }`);
    expect(schema).not.toContain("data");
    expect(issueAt(issues, "JSON")?.severity).toBe("unsupported");
    expect(issueAt(issues, "T.data")?.severity).toBe("unsupported");
  });

  it("accepts a redeclared built-in scalar", () => {
    expect(convert(`scalar DateTime\ntype T @node { at: DateTime }`).schema).toContain(
      "at DateTime?",
    );
  });

  it("drops lists of lists", () => {
    const { schema, issues } = convert(`type T @node { name: String, grid: [[Int!]!]! }`);
    expect(schema).not.toContain("grid");
    expect(issueAt(issues, "T.grid")?.feature).toBe("nested list");
  });

  it("only treats @node object types as nodes (v7)", () => {
    const { schema, issues } = convert(`
      type T @node { id: ID! }
      type Stats { count: Int }
      type Query { stats: Stats @cypher(statement: "RETURN 1 AS s", columnName: "s") }
      input Filter { q: String }
      type JWT @jwt { roles: [String!]! }
    `);
    expect(schema).toBe("node T {\n  id String\n}\n");
    expect(issueAt(issues, "Stats")).toMatchObject({ severity: "unsupported", feature: "@node" });
    expect(issueAt(issues, "Query")?.severity).toBe("unsupported");
    expect(issueAt(issues, "Filter")?.severity).toBe("ignored");
    expect(issueAt(issues, "JWT")?.severity).toBe("ignored");
  });

  it("reports interfaces and unions and the relationships to them", () => {
    const { schema, issues } = convert(`
      interface Production { title: String! }
      type Movie implements Production @node { title: String! }
      type Series implements Production @node { title: String! }
      union Media = Movie | Series
      type Person @node {
        name: String
        actedIn: [Production!]! @relationship(type: "ACTED_IN", direction: OUT)
        likes: [Media!]! @relationship(type: "LIKES", direction: OUT)
      }
    `);
    expect(schema).toContain("node Movie {\n  title String\n}");
    expect(schema).not.toContain("actedIn");
    expect(schema).not.toContain("likes");
    expect(issueAt(issues, "Production")?.feature).toBe("interface");
    expect(issueAt(issues, "Media")?.feature).toBe("union");
    expect(issueAt(issues, "Person.actedIn")?.message).toMatch(/interface/);
    expect(issueAt(issues, "Person.likes")?.message).toMatch(/union/);
  });

  it("merges extend type into the base type", () => {
    const { schema } = convert(`
      type T @node { a: String }
      extend type T { b: Int }
    `);
    expect(schema).toContain("a String?\n  b Int?");
  });
});

describe("convertGraphQLTypeDefs: field directives", () => {
  it("@id becomes @id @default(uuid()) and is required", () => {
    const { schema, issues } = convert(`type T @node { id: ID @id }`);
    expect(schema).toContain("id String @id @default(uuid())");
    expect(issueAt(issues, "T.id")).toMatchObject({ severity: "changed", feature: "@id" });
  });

  it("a second @id becomes @unique @default(uuid())", () => {
    const { schema } = convert(`type T @node { id: ID! @id, other: ID! @id }`);
    expect(schema).toContain("other String @unique @default(uuid())");
  });

  it("@id on a non-ID field is reported", () => {
    const { schema, issues } = convert(`type T @node { id: String! @id }`);
    expect(schema).toContain("id String\n");
    expect(issueAt(issues, "T.id")?.severity).toBe("unsupported");
  });

  it("@timestamp on create becomes @default(now())", () => {
    const { schema, issues } = convert(
      `type T @node { createdAt: DateTime! @timestamp(operations: [CREATE]) }`,
    );
    expect(schema).toContain("createdAt DateTime @default(now())");
    expect(issues).toEqual([]);
  });

  it("@timestamp with update (the default) is reported", () => {
    const { schema, issues } = convert(`type T @node { at: DateTime! @timestamp }`);
    expect(schema).toContain("at DateTime @default(now())");
    expect(issueAt(issues, "T.at")).toMatchObject({ severity: "changed", feature: "@timestamp" });
  });

  it("@timestamp on update only makes the field optional", () => {
    const { schema, issues } = convert(
      `type T @node { updatedAt: DateTime! @timestamp(operations: [UPDATE]) }`,
    );
    expect(schema).toContain("updatedAt DateTime?\n");
    expect(issueAt(issues, "T.updatedAt")?.severity).toBe("unsupported");
  });

  it("@default literals", () => {
    const { schema, issues } = convert(`
      enum S { A B }
      type T @node {
        s: String! @default(value: "x")
        i: Int! @default(value: 3)
        f: Float! @default(value: 1.5)
        b: Boolean! @default(value: true)
        e: S! @default(value: B)
      }
    `);
    expect(schema).toContain('s String @default("x")');
    expect(schema).toContain("i Int @default(3)");
    expect(schema).toContain("f Float @default(1.5)");
    expect(schema).toContain("b Boolean @default(true)");
    expect(schema).toContain("e S @default(B)");
    expect(issues.filter((i) => i.feature === "@default")).toEqual([]);
  });

  it("@default values Cyphra cannot express are reported", () => {
    const { schema, issues } = convert(`
      type T @node {
        at: DateTime @default(value: "2020-01-01T00:00:00Z")
        n: Int @default(value: "x")
        l: [String!]! @default(value: ["a"])
      }
    `);
    expect(schema).not.toContain("@default");
    expect(issues.filter((i) => i.feature === "@default").map((i) => i.at)).toEqual([
      "T.at",
      "T.n",
      "T.l",
    ]);
  });

  it("@unique (removed in v7) is kept with a note", () => {
    const { schema, issues } = convert(`type T @node { email: String! @unique }`);
    expect(schema).toContain("email String @unique");
    expect(issueAt(issues, "T.email")).toMatchObject({ severity: "changed", feature: "@unique" });
  });

  it("@alias renames the field to the Neo4j property", () => {
    const { schema, issues } = convert(
      `type T @node { displayName: String @alias(property: "display_name") }`,
    );
    expect(schema).toContain("display_name String?");
    expect(issueAt(issues, "T.displayName")?.feature).toBe("@alias");
  });

  it("@alias clashing with another field keeps the first", () => {
    const { schema, issues } = convert(
      `type T @node { name: String, title: String @alias(property: "name") }`,
    );
    expect(schema).toBe("node T {\n  name String?\n}\n");
    expect(issueAt(issues, "T.name")?.feature).toBe("field name");
  });

  it.each(["cypher", "customResolver"])("@%s fields are dropped and reported", (name) => {
    const args = name === "cypher" ? `(statement: "RETURN 1 AS x", columnName: "x")` : "";
    const result = convertGraphQLTypeDefs(`type T @node { a: String, x: Int @${name}${args} }`);
    expect(printSchemaDocument(result.document)).not.toContain(" x ");
    expect(issueAt(result.issues, "T.x")).toMatchObject({
      severity: "unsupported",
      feature: `@${name}`,
    });
    expect(result.notes.get("T")).toEqual(["x: Int (not converted: computed field)"]);
  });

  it.each([
    ["authorization(filter: [])", "unsupported"],
    ["authentication", "unsupported"],
    ['populatedBy(callback: "f")', "unsupported"],
    ["coalesce(value: 1)", "unsupported"],
    ["selectable(onRead: false)", "ignored"],
    ["settable(onCreate: false)", "ignored"],
    ["filterable(byValue: false)", "ignored"],
    ["sortable(byValue: false)", "ignored"],
  ])("@%s is reported as %s and the field kept", (dir, severity) => {
    const { schema, issues } = convert(`type T @node { x: Int @${dir} }`);
    expect(schema).toContain("x Int?");
    expect(issueAt(issues, "T.x")?.severity).toBe(severity);
  });

  it("unknown directives are reported", () => {
    const { issues } = convert(`type T @node @mine { x: Int @other }`);
    expect(issues.map((i) => [i.at, i.feature])).toEqual([
      ["T", "@mine"],
      ["T.x", "@other"],
    ]);
  });
});

describe("convertGraphQLTypeDefs: type directives", () => {
  it("@node(labels) renames the node to its label and updates relation targets", () => {
    const { schema, issues } = convert(`
      type Movie @node(labels: ["Film"]) { title: String }
      type Person @node { films: [Movie!]! @relationship(type: "ACTED_IN", direction: OUT) }
    `);
    expect(schema).toContain("node Film {");
    expect(schema).toContain("films Film[]");
    expect(issueAt(issues, "Movie")?.severity).toBe("changed");
  });

  it("@node with extra and dynamic labels is reported", () => {
    const { schema, issues } = convert(`
      type A @node(labels: ["A", "Extra"]) { x: Int }
      type B @node(labels: ["$jwt.tenant"]) { x: Int }
    `);
    expect(schema).toContain("node A {");
    expect(schema).toContain("node B {");
    expect(issueAt(issues, "A")?.message).toMatch(/"Extra"/);
    expect(issueAt(issues, "B")?.message).toMatch(/dynamic/);
  });

  it.each([
    ['plural(value: "Ts")', "ignored"],
    [
      'vector(indexes: [{ indexName: "v", embeddingProperty: "e", queryName: "q" }])',
      "unsupported",
    ],
    ["authorization(filter: [])", "unsupported"],
    ["limit(default: 10)", "ignored"],
    ["query(read: true)", "ignored"],
  ])("@%s is reported as %s", (dir, severity) => {
    const { issues } = convert(`type T @node @${dir} { x: Int }`);
    expect(issueAt(issues, "T")?.severity).toBe(severity);
  });
});

describe("convertGraphQLTypeDefs: @fulltext", () => {
  it("becomes @@fulltext with the index name; queryName is reported as ignored", () => {
    const result = convertGraphQLTypeDefs(`
      type Book
        @node
        @fulltext(
          indexes: [
            { indexName: "BookTitle", queryName: "booksByTitle", fields: ["title"] }
            { indexName: "BookText", queryName: "searchBooks", fields: ["title", "summary"] }
          ]
        ) {
        isbn: ID!
        title: String!
        summary: String
      }
    `);
    const schema = printSchemaDocument(result.document);
    expect(schema).toContain(`  @@fulltext([title], name: "BookTitle")
  @@fulltext([title, summary], name: "BookText")`);
    const doc = parseSchema(schema);
    validateSchema(doc);
    expect(resolveSchema(doc).nodes[0]?.fulltextIndexes?.map((i) => i.name)).toEqual([
      "BookTitle",
      "BookText",
    ]);
    expect(result.issues.filter((i) => i.feature.startsWith("@fulltext"))).toEqual([
      expect.objectContaining({ severity: "ignored", feature: "@fulltext(queryName)" }),
      expect.objectContaining({ severity: "ignored", feature: "@fulltext(queryName)" }),
    ]);
  });

  it("uses the Cyphra field names after @alias and accepts ID fields", () => {
    const { schema } = convert(`
      type T @node @fulltext(indexes: [{ indexName: "t_text", queryName: "q", fields: ["code", "label"] }]) {
        code: ID!
        label: String @alias(property: "display_label")
      }
    `);
    expect(schema).toContain('@@fulltext([code, display_label], name: "t_text")');
  });

  it("reports and leaves out indexes it cannot convert", () => {
    const { schema, issues } = convert(`
      type T
        @node
        @fulltext(
          indexes: [
            { indexName: "ok", queryName: "q1", fields: ["a"] }
            { indexName: "badField", queryName: "q2", fields: ["n"] }
            { indexName: "missing", queryName: "q3", fields: ["nope"] }
            { indexName: "bad-name", queryName: "q4", fields: ["a"] }
            { queryName: "q5", fields: ["a"] }
          ]
        ) {
        a: String
        n: Int
      }
    `);
    expect(schema).toContain('@@fulltext([a], name: "ok")');
    expect(schema.match(/@@fulltext/g)).toHaveLength(1);
    const messages = issues
      .filter((i) => i.feature === "@fulltext" && i.severity === "unsupported")
      .map((i) => i.message);
    expect(messages).toEqual([
      expect.stringMatching(/"bad-name"/),
      expect.stringMatching(/indexName and fields/),
      expect.stringMatching(/"badField": field "n" is not a String/),
      expect.stringMatching(/"missing": field "nope" was not converted/),
    ]);
  });
});

describe("convertGraphQLTypeDefs: relationships", () => {
  it("maps type, direction and cardinality", () => {
    const { schema } = convert(`
      type A @node {
        bs: [B!]! @relationship(type: "HAS", direction: OUT)
        one: B! @relationship(type: "ONE", direction: OUT)
        maybe: B @relationship(type: "MAYBE", direction: IN)
      }
      type B @node { as: [A!]! @relationship(type: "HAS", direction: IN) }
    `);
    expect(schema).toContain('bs B[] @relationship(type: "HAS", direction: OUT)');
    expect(schema).toContain('one B @relationship(type: "ONE", direction: OUT)');
    expect(schema).toContain('maybe B? @relationship(type: "MAYBE", direction: IN)');
    expect(schema).toContain('as A[] @relationship(type: "HAS", direction: IN)');
  });

  it("relationship properties become one relationship model shared by both sides", () => {
    const result = convertGraphQLTypeDefs(`
      type Actor @node { movies: [Movie!]! @relationship(type: "ACTED_IN", direction: OUT, properties: "ActedIn") }
      type Movie @node { actors: [Actor!]! @relationship(type: "ACTED_IN", direction: IN, properties: "ActedIn") }
      type ActedIn @relationshipProperties { roles: [String!], since: Int @default(value: 2000) }
    `);
    const schema = printSchemaDocument(result.document);
    expect(schema).toContain(`relationship ActedIn {
  type "ACTED_IN"
  from Actor
  to Movie
  roles String[]
  since Int? @default(2000)
}`);
    const model = resolveSchema(parseSchema(schema));
    const actor = model.nodes.find((n) => n.name === "Actor")!;
    const movie = model.nodes.find((n) => n.name === "Movie")!;
    expect(actor.fields[0]).toMatchObject({ edge: "ActedIn" });
    expect(movie.fields[0]).toMatchObject({ edge: "ActedIn" });
  });

  it("a properties type used by several node pairs becomes one model per pair", () => {
    const { schema, issues } = convert(`
      type A @node { cs: [C!]! @relationship(type: "R", direction: OUT, properties: "Since") }
      type B @node { cs: [C!]! @relationship(type: "R", direction: OUT, properties: "Since") }
      type C @node { name: String }
      type Since @relationshipProperties { at: DateTime }
    `);
    expect(schema).toContain("relationship SinceAC {");
    expect(schema).toContain("relationship SinceBC {");
    expect(issues.filter((i) => i.at === "Since")).toHaveLength(2);
  });

  it("@id and @timestamp on relationship properties", () => {
    const { schema, issues } = convert(`
      type A @node { bs: [B!]! @relationship(type: "R", direction: OUT, properties: "P") }
      type B @node { x: Int }
      type P @relationshipProperties { id: ID! @id, at: DateTime! @timestamp(operations: [CREATE]) }
    `);
    expect(schema).toContain("id String @default(uuid())");
    expect(schema).toContain("at DateTime @default(now())");
    expect(issueAt(issues, "P.id")?.severity).toBe("changed");
  });

  it("unused relationship properties types are reported", () => {
    const { schema, issues } = convert(`
      type A @node { x: Int }
      type P @relationshipProperties { since: Int }
    `);
    expect(schema).not.toContain("relationship");
    expect(issueAt(issues, "P")?.severity).toBe("ignored");
  });

  it("queryDirection, nestedOperations and aggregate are reported", () => {
    const { issues } = convert(`
      type A @node {
        bs: [B!]! @relationship(type: "R", direction: OUT, queryDirection: UNDIRECTED, nestedOperations: [CONNECT], aggregate: false)
      }
      type B @node { x: Int }
    `);
    expect(issues.map((i) => [i.feature, i.severity])).toEqual([
      ["@relationship(queryDirection)", "changed"],
      ["@relationship(nestedOperations)", "ignored"],
      ["@relationship(aggregate)", "ignored"],
    ]);
  });

  it("an object field without @relationship is reported", () => {
    const { schema, issues } = convert(`
      type A @node { b: B }
      type B @node { x: Int }
    `);
    expect(schema).toContain("node A {\n}");
    expect(issueAt(issues, "A.b")?.feature).toBe("@relationship");
  });

  it("properties that are not a @relationshipProperties type are reported", () => {
    const { schema, issues } = convert(`
      type A @node { bs: [B!]! @relationship(type: "R", direction: OUT, properties: "B") }
      type B @node { x: Int }
    `);
    expect(schema).toContain("bs B[]");
    expect(issueAt(issues, "A.bs")?.feature).toBe("@relationship(properties)");
  });
});

describe("convertGraphQLTypeDefs: invalid SDL", () => {
  it("throws on a syntax error with the file and position", () => {
    expect(() =>
      convertGraphQLTypeDefs([{ name: "schema.graphql", body: "type T @node {\n  x: \n}" }]),
    ).toThrow(/schema\.graphql:3:1: Syntax Error/);
  });

  it("throws on an unknown type", () => {
    expect(() => convertGraphQLTypeDefs("type T @node { x: Nope }")).toThrow(GraphQLImportError);
  });

  it("throws on a duplicate type", () => {
    expect(() =>
      convertGraphQLTypeDefs([
        { name: "a.graphql", body: "type T @node { x: Int }" },
        { name: "b.graphql", body: "type T @node { y: Int }" },
      ]),
    ).toThrow(/b\.graphql: type "T" is defined more than once/);
  });

  it("throws on an extension of an unknown type", () => {
    expect(() => convertGraphQLTypeDefs("extend type T { x: Int }")).toThrow(GraphQLImportError);
  });
});
