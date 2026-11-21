import { describe, expect, it } from "vitest";
import type { NodeDeclaration } from "./ast.js";
import { SchemaValidationError } from "./errors.js";
import { getNodeModel, resolveSchema } from "./model.js";
import { parseSchema } from "./parseSchema.js";
import { formatModelAttribute, printSchemaDocument } from "./printSchema.js";
import { renderCyphraGenSource } from "./renderCyphraGen.js";

const schema = `
node Post {
  id    String   @id
  title String
  body  String?
  tags  String[]
  views Int

  @@fulltext([title, body], name: "postSearch", analyzer: "english", eventuallyConsistent: false)
  @@fulltext([tags])
}
`;

const bad = (src: string) => () => parseSchema(src);
const badModel = (src: string) => () => resolveSchema(parseSchema(src));
const post = (body: string) =>
  `node Post {\n  id String @id\n  title String\n  body String?\n  tags String[]\n  views Int\n  ${body}\n}`;

describe("model-level attributes", () => {
  it("parses @@fulltext with a field list and named arguments", () => {
    const node = parseSchema(schema).declarations[0] as NodeDeclaration;
    expect(node.kind).toBe("Node");
    expect(node.fields.map((f) => f.name)).toEqual(["id", "title", "body", "tags", "views"]);
    expect(node.attributes).toEqual([
      {
        kind: "ModelAttribute",
        name: "fulltext",
        fields: ["title", "body"],
        args: [
          { key: "name", value: { kind: "string", value: "postSearch" } },
          { key: "analyzer", value: { kind: "string", value: "english" } },
          { key: "eventuallyConsistent", value: { kind: "boolean", value: false } },
        ],
      },
      { kind: "ModelAttribute", name: "fulltext", fields: ["tags"], args: [] },
    ]);
  });

  it("keeps the AST unchanged for models without attributes", () => {
    const node = parseSchema("node A { id String @id }").declarations[0]!;
    expect(node).not.toHaveProperty("attributes");
  });

  it("accepts attributes anywhere in the body, and comments around them", () => {
    const doc = parseSchema(`node A {
  // search
  @@fulltext([name]) // trailing
  id   String @id
  name String
}`);
    const a = doc.declarations[0] as NodeDeclaration;
    expect(a.fields.map((f) => f.name)).toEqual(["id", "name"]);
    expect(a.attributes?.map((x) => x.fields)).toEqual([["name"]]);
  });

  it("rejects unknown attributes and attributes on relationships", () => {
    expect(bad(post("@@nope([title])"))).toThrow(
      /unknown model attribute @@nope \(expected @@fulltext\)/,
    );
    expect(
      bad(`node A { id String @id }
relationship R {
  type "R"
  from A
  to A
  note String
  @@fulltext([note])
}`),
    ).toThrow(/only supported on node models/);
  });

  it("prints attributes back after the fields and round-trips", () => {
    const printed = printSchemaDocument(parseSchema(schema));
    expect(printed).toBe(`node Post {
  id String @id
  title String
  body String?
  tags String[]
  views Int

  @@fulltext([title, body], name: "postSearch", analyzer: "english", eventuallyConsistent: false)
  @@fulltext([tags])
}
`);
    expect(printSchemaDocument(parseSchema(printed))).toBe(printed);
    expect(formatModelAttribute({ kind: "ModelAttribute", name: "x", args: [] })).toBe("@@x");
    expect(
      formatModelAttribute({
        kind: "ModelAttribute",
        name: "x",
        args: [{ key: "a", value: { kind: "number", value: 1 } }],
      }),
    ).toBe("@@x(a: 1)");
  });
});

describe("@@fulltext", () => {
  it("resolves indexes with names, analyzer and consistency", () => {
    const p = getNodeModel(resolveSchema(parseSchema(schema)), "Post");
    expect(p.fulltextIndexes).toEqual([
      {
        name: "postSearch",
        fields: ["title", "body"],
        analyzer: "english",
        eventuallyConsistent: false,
      },
      { name: "Post_tags_fulltext", fields: ["tags"] },
    ]);
    const plain = getNodeModel(resolveSchema(parseSchema("node A { id String @id }")), "A");
    expect(plain).not.toHaveProperty("fulltextIndexes");
  });

  it("accepts an analyzer given as an identifier", () => {
    const p = getNodeModel(
      resolveSchema(parseSchema(post("@@fulltext([title], analyzer: whitespace)"))),
      "Post",
    );
    expect(p.fulltextIndexes?.[0]?.analyzer).toBe("whitespace");
  });

  it("validates fields", () => {
    expect(bad(post("@@fulltext"))).toThrow(/needs a list of String fields/);
    expect(bad(post("@@fulltext([])"))).toThrow(/needs a list of String fields/);
    expect(bad(post('@@fulltext(name: "x")'))).toThrow(/needs a list of String fields/);
    expect(bad(post("@@fulltext([nope])"))).toThrow(/field "nope" does not exist/);
    expect(bad(post("@@fulltext([views])"))).toThrow(
      /"views" must be a String or String\[\] field/,
    );
    expect(bad(post("@@fulltext([title, title])"))).toThrow(/lists field "title" twice/);
    expect(
      bad(
        `node A { id String @id\n b B? @relationship(type: "R")\n @@fulltext([b]) }\nnode B { id String @id }`,
      ),
    ).toThrow(/"b" must be a String/);
  });

  it("validates arguments", () => {
    expect(bad(post('@@fulltext([title], analyzer: "klingon")'))).toThrow(
      /unknown @@fulltext analyzer "klingon" \(expected one of arabic, .*standard-no-stop-words/,
    );
    expect(bad(post("@@fulltext([title], analyzer: 3)"))).toThrow(
      /unknown @@fulltext analyzer "3"/,
    );
    expect(bad(post('@@fulltext([title], name: "has space")'))).toThrow(
      /name must be a string of letters/,
    );
    expect(bad(post("@@fulltext([title], eventuallyConsistent: 1)"))).toThrow(
      /eventuallyConsistent must be true or false/,
    );
    expect(bad(post("@@fulltext([title], boost: 2)"))).toThrow(
      /unknown @@fulltext argument "boost"/,
    );
    expect(bad(post('@@fulltext([title], name: "a", name: "b")'))).toThrow(/name given twice/);
    try {
      parseSchema(post("@@fulltext([views])"));
    } catch (e) {
      expect(e).toBeInstanceOf(SchemaValidationError);
    }
  });

  it("requires index names to be unique across every index and constraint", () => {
    expect(badModel(post("@@fulltext([title])\n@@fulltext([title])"))).toThrow(
      /index name "Post_title_fulltext" is already used/,
    );
    expect(
      badModel(
        `node A { id String @id\n t String\n @@fulltext([t], name: "s") }\nnode B { id String @id\n t String\n @@fulltext([t], name: "s") }`,
      ),
    ).toThrow(/Node "B" @@fulltext: index name "s" is already used by @@fulltext on A/);
    expect(
      badModel(
        `node A { id String @id\n e Vector(2)? @vectorIndex(name: "s")\n t String\n @@fulltext([t], name: "s") }`,
      ),
    ).toThrow(/index name "s" is already used by A\.e/);
    expect(
      badModel(
        `node A { id String @id\n slug String @index\n @@fulltext([slug], name: "A_slug_idx") }`,
      ),
    ).toThrow(/"A_slug_idx" is already used by A\.slug/);
    expect(badModel(post('@@fulltext([title], name: "Post_id_id")'))).toThrow(
      /already used by Post\.id/,
    );
  });

  it("emits the index names in the generated type map", () => {
    const gen = renderCyphraGenSource(parseSchema(schema));
    expect(gen).toContain('    fulltextIndexes: "postSearch" | "Post_tags_fulltext";');
    expect(gen).toContain('"fulltextIndexes": [');
    expect(renderCyphraGenSource(parseSchema("node A { id String @id }"))).not.toContain(
      "fulltextIndexes",
    );
  });
});
