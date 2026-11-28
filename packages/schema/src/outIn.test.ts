import { describe, expect, it } from "vitest";
import { formatSchema } from "./formatSchema.js";
import { schemaWarnings, similarRelationshipTypes } from "./lint.js";
import { resolveSchema, type ResolvedRelationField, type SchemaModel } from "./model.js";
import { parseSchema, parseSchemaSyntax } from "./parseSchema.js";
import { printSchemaDocument } from "./printSchema.js";
import { renderCyphraGenSource } from "./renderCyphraGen.js";

const resolve = (src: string) => resolveSchema(parseSchema(src));
const field = (m: SchemaModel, node: string, name: string) =>
  m.nodes.find((n) => n.name === node)!.fields.find((f) => f.name === name) as
    ResolvedRelationField | undefined;

const BLOG = `
node User {
  id    String @id
  posts Post[] @out(AUTHORED)
}

node Post {
  id     String @id
  title  String
  author User?  @in(AUTHORED)
}

relationship AUTHORED {
  at DateTime @default(now())
}
`;

describe("@out / @in relation fields", () => {
  it("resolves both sides and types $edge with the short-form block", () => {
    const m = resolve(BLOG);
    expect(field(m, "User", "posts")).toEqual({
      kind: "relation",
      name: "posts",
      target: "Post",
      relType: "AUTHORED",
      direction: "OUT",
      many: true,
      optional: false,
      edge: "AUTHORED",
    });
    expect(field(m, "Post", "author")).toEqual({
      kind: "relation",
      name: "author",
      target: "User",
      relType: "AUTHORED",
      direction: "IN",
      many: false,
      optional: true,
      edge: "AUTHORED",
    });
    expect(m.relationships).toEqual([
      {
        name: "AUTHORED",
        relType: "AUTHORED",
        from: "User",
        to: "Post",
        properties: [
          {
            kind: "scalar",
            name: "at",
            type: "DateTime",
            optional: false,
            list: false,
            id: false,
            unique: false,
            index: false,
            default: { kind: "fn", fn: "now" },
          },
        ],
      },
    ]);
  });

  it("needs only one side", () => {
    const m = resolve(`
      node User { id String @id
        posts Post[] @out(AUTHORED) }
      node Post { id String @id }
      relationship AUTHORED { at DateTime? }
    `);
    expect(field(m, "User", "posts")).toMatchObject({ edge: "AUTHORED", direction: "OUT" });
    expect(m.relationships[0]).toMatchObject({ from: "User", to: "Post" });
    // The inverse side alone works the same.
    const inv = resolve(`
      node User { id String @id }
      node Post { id String @id
        author User @in(AUTHORED) }
      relationship AUTHORED { at DateTime? }
    `);
    expect(field(inv, "Post", "author")).toMatchObject({ edge: "AUTHORED", direction: "IN" });
    expect(inv.relationships[0]).toMatchObject({ from: "User", to: "Post" });
  });

  it("needs no block when the edge has no properties", () => {
    const m = resolve(`
      node User { id String @id
        posts Post[] @out(AUTHORED) }
      node Post { id String @id
        author User? @in(AUTHORED) }
    `);
    expect(field(m, "User", "posts")).not.toHaveProperty("edge");
    expect(field(m, "Post", "author")).toMatchObject({ relType: "AUTHORED", direction: "IN" });
    expect(m.relationships).toEqual([]);
  });

  it("takes onDelete in the same call", () => {
    const m = resolve(`
      node User { id String @id
        posts Post[] @out(AUTHORED, onDelete: Cascade) }
      node Post { id String @id
        author User? @in(AUTHORED, onDelete: Restrict) }
    `);
    expect(field(m, "User", "posts")).toMatchObject({ onDelete: "Cascade" });
    expect(field(m, "Post", "author")).toMatchObject({ onDelete: "Restrict" });
    expect(() =>
      resolve(`node A { id String @id
        b A[] @out(X, onDelete: Nope) }`),
    ).toThrow(/onDelete must be Cascade, Restrict, SetNull/);
  });

  it("supports self-relationships", () => {
    const m = resolve(`
      node User {
        id        String @id
        following User[] @out(FOLLOWS)
        followers User[] @in(FOLLOWS)
      }
      relationship FOLLOWS { since DateTime @default(now()) }
    `);
    expect(field(m, "User", "following")).toMatchObject({ direction: "OUT", edge: "FOLLOWS" });
    expect(field(m, "User", "followers")).toMatchObject({ direction: "IN", edge: "FOLLOWS" });
    expect(m.relationships[0]).toMatchObject({ from: "User", to: "User" });
  });

  it("supports a union target", () => {
    const m = resolve(`
      union SearchHit = Post | User
      node Post { id String @id
        taggedBy Tag[] @in(TAGS) }
      node User { id String @id }
      node Tag { id String @id
        targets SearchHit[] @out(TAGS) }
      relationship TAGS { weight Int @default(1) }
    `);
    expect(field(m, "Tag", "targets")).toMatchObject({ target: "SearchHit", edge: "TAGS" });
    expect(field(m, "Post", "taggedBy")).toMatchObject({ edge: "TAGS" });
    // The union covers Post: the model goes from Tag to SearchHit.
    expect(m.relationships[0]).toMatchObject({ from: "Tag", to: "SearchHit" });
  });

  it("supports an interface target and inherited relation fields", () => {
    const m = resolve(`
      interface Content {
        id     String @id
        author User   @in(WROTE)
      }
      node Post implements Content { title String }
      node Video implements Content { url String }
      node User {
        id       String    @id
        contents Content[] @out(WROTE)
      }
      relationship WROTE { at DateTime? }
    `);
    expect(field(m, "User", "contents")).toMatchObject({ target: "Content", edge: "WROTE" });
    expect(field(m, "Post", "author")).toMatchObject({
      edge: "WROTE",
      direction: "IN",
      inheritedFrom: "Content",
    });
    expect(m.relationships[0]).toMatchObject({ from: "User", to: "Content" });
  });

  it("uses the most general ends when fields name an interface and its implementation", () => {
    const m = resolve(`
      interface Content { id String @id }
      node Post implements Content { title String }
      node User {
        id       String    @id
        contents Content[] @out(WROTE)
        posts    Post[]    @out(WROTE)
      }
      relationship WROTE { at DateTime? }
    `);
    expect(m.relationships[0]).toMatchObject({ from: "User", to: "Content" });
    expect(field(m, "User", "posts")).toMatchObject({ edge: "WROTE" });
  });

  it("rejects a short-form block whose edges link unrelated pairs of nodes", () => {
    expect(() =>
      resolve(`
        node User { id String @id
          posts Post[] @out(AUTHORED) }
        node Team { id String @id
          posts Post[] @out(AUTHORED) }
        node Post { id String @id }
        relationship AUTHORED { at DateTime? }
      `),
    ).toThrow(
      /Relationship "AUTHORED": :AUTHORED edges link different pairs of nodes \(User to Post, Team to Post\)/,
    );
    // Without a block, the type may link any nodes.
    expect(() =>
      resolve(`
        node User { id String @id
          posts Post[] @out(AUTHORED) }
        node Team { id String @id
          posts Post[] @out(AUTHORED) }
        node Post { id String @id }
      `),
    ).not.toThrow();
  });

  it("resolves exactly like the @relationship syntax (same model, same generated client)", () => {
    const old = `
      node User {
        id    String @id
        posts Post[] @relationship(type: "AUTHORED", direction: OUT)
      }
      node Post {
        id     String @id
        title  String
        author User?  @relationship(type: "AUTHORED", direction: IN)
      }
      relationship AUTHORED {
        type "AUTHORED"
        from User
        to   Post
        at   DateTime @default(now())
      }
    `;
    expect(resolve(BLOG)).toEqual(resolve(old));
    expect(renderCyphraGenSource(parseSchema(BLOG))).toBe(renderCyphraGenSource(parseSchema(old)));
  });

  it("works with a long-form block too", () => {
    const m = resolve(`
      node User { id String @id
        posts Post[] @out(AUTHORED) }
      node Post { id String @id }
      relationship Wrote { type "AUTHORED"
        from User
        to Post
        at DateTime? }
    `);
    expect(field(m, "User", "posts")).toMatchObject({ edge: "Wrote" });
  });

  it("rejects a bad @out / @in", () => {
    const bad = (decorators: string) => () =>
      resolve(`node A { id String @id
        b A[] ${decorators} }`);
    expect(bad("@out")).toThrow(/@out needs the relationship type, e\.g\. @out\(AUTHORED\)/);
    expect(bad('@in("HAS-TAG")')).toThrow(/write the type without quotes, or use @relationship/);
    expect(bad("@out(X, direction: IN)")).toThrow(
      /unknown @out argument "direction" \(expected type, onDelete\) \(@out already gives the direction\)/,
    );
    expect(bad("@out(X, Cascade)")).toThrow(
      /@out takes the type, then named arguments only: @out\(TYPE, onDelete: Cascade\)/,
    );
    expect(bad("@out(X, onDelete: Cascade, onDelete: Restrict)")).toThrow(
      /@out onDelete given twice/,
    );
    expect(bad("@out(X) @out(X)")).toThrow(/at most one @out allowed/);
  });

  it("rejects mixing the syntaxes on one field", () => {
    const bad = (decorators: string) => () =>
      resolve(`node A { id String @id
        b A[] ${decorators} }`);
    expect(bad('@out(X) @relationship(type: "X", direction: OUT)')).toThrow(
      /use one of @out\(TYPE\), @in\(TYPE\) or @relationship\(…\), not @out and @relationship/,
    );
    expect(bad("@out(X) @in(X)")).toThrow(/not @out and @in/);
  });

  it("rejects a short-form and a long-form block for the same type", () => {
    expect(() =>
      resolve(`
        node User { id String @id
          posts Post[] @out(AUTHORED) }
        node Post { id String @id }
        relationship AUTHORED { at DateTime? }
        relationship Wrote { type "AUTHORED"
          from User
          to Post }
      `),
    ).toThrow(/relationship AUTHORED \{ … \} already types every :AUTHORED edge/);
  });
});

describe("relationship validation (both syntaxes)", () => {
  it("rejects a pair with the same direction on both sides", () => {
    expect(() =>
      resolve(`
        node User { id String @id
          posts Post[] @out(AUTHORED) }
        node Post { id String @id
          author User? @out(AUTHORED) }
      `),
    ).toThrow(
      'Node "Post" field "author": @out(AUTHORED) has the same direction as User.posts (@out(AUTHORED)), so they describe different edges; if it is the inverse of User.posts, use @in(AUTHORED).',
    );
    expect(() =>
      resolve(`
        node User { id String @id
          posts Post[] @relationship(type: "AUTHORED", direction: IN) }
        node Post { id String @id
          author User? @relationship(type: "AUTHORED", direction: IN) }
      `),
    ).toThrow(/use @relationship\(type: "AUTHORED", direction: OUT\)/);
  });

  it("accepts the same direction on both sides when each has its inverse", () => {
    // A -[T]-> B and B -[T]-> A both exist, each declared from both ends.
    expect(() =>
      resolve(`
        node A { id String @id
          bs  B[] @out(T)
          bsIn B[] @in(T) }
        node B { id String @id
          as  A[] @out(T)
          asIn A[] @in(T) }
      `),
    ).not.toThrow();
  });

  it("rejects a block no field uses", () => {
    expect(() =>
      resolve(`
        node User { id String @id
          posts Post[] @out(AUTHORED) }
        node Post { id String @id }
        relationship AUTHROED { at DateTime? }
      `),
    ).toThrow(
      'Relationship "AUTHROED": no relation field uses it (add a field with @out(AUTHROED) or @in(AUTHROED), or remove the block).',
    );
    // Long form: a field with the wrong direction does not use it.
    expect(() =>
      resolve(`
        node User { id String @id
          posts Post[] @relationship(type: "AUTHORED", direction: IN) }
        node Post { id String @id }
        relationship Wrote { type "AUTHORED"
          from User
          to Post }
      `),
    ).toThrow(
      'Relationship "Wrote": no relation field uses it (add a field with @out(AUTHORED) on User or @in(AUTHORED) on Post, or remove the block).',
    );
    // A type that is not an identifier is suggested with @relationship.
    expect(() =>
      resolve(`
        node A { id String @id }
        relationship R { type "HAS-TAG"
          from A
          to A }
      `),
    ).toThrow(
      'add a field with @relationship(type: "HAS-TAG", direction: OUT) on A or @relationship(type: "HAS-TAG", direction: IN) on A',
    );
  });

  it("warns about nearly identical relationship types", () => {
    const doc = parseSchemaSyntax(
      `
      node User { id String @id
        posts Post[] @out(AUTHORED)
        likes Post[] @relationship(type: "Authored", direction: OUT) }
      node Post { id String @id
        author User? @in(AUTHORD) }
    `,
      { locations: true },
    );
    const warnings = schemaWarnings(doc);
    expect(warnings.map((w) => w.message)).toEqual([
      "Relationship types Authored (User.likes) and AUTHORED (User.posts) are nearly identical: they are different edge types, is one of them a typo?",
      "Relationship types AUTHORD (Post.author) and AUTHORED (User.posts) are nearly identical: they are different edge types, is one of them a typo?",
    ]);
    expect(warnings[1]!.code).toBe("similar-relationship-types");
    // The squiggle is on the type itself.
    const src = doc.declarations[1]!;
    expect(warnings[1]!.loc?.start.line).toBe(src.kind === "Node" ? 6 : -1);
  });

  it("does not flag clearly different or very short types", () => {
    expect(similarRelationshipTypes("AUTHORED", "AUTHORED")).toBe(false);
    expect(similarRelationshipTypes("IN", "ON")).toBe(false);
    expect(similarRelationshipTypes("LIKES", "FOLLOWS")).toBe(false);
    expect(similarRelationshipTypes("HAS_TAG", "HASTAG")).toBe(true);
    expect(similarRelationshipTypes("FOLLOWS", "follows")).toBe(true);
    expect(schemaWarnings(parseSchemaSyntax(BLOG))).toEqual([]);
  });
});

describe("printing and formatting", () => {
  it("prints @out / @in with the type positional, and the short-form block", () => {
    const printed = printSchemaDocument(
      parseSchema(BLOG.replace("@out(AUTHORED)", "@out(type: AUTHORED, onDelete: Cascade)")),
    );
    expect(printed).toContain("  posts Post[] @out(AUTHORED, onDelete: Cascade)");
    expect(printed).toContain("relationship AUTHORED {\n  at DateTime @default(now())\n}");
    expect(resolveSchema(parseSchema(printed))).toEqual(
      resolve(BLOG.replace("@out(AUTHORED)", "@out(AUTHORED, onDelete: Cascade)")),
    );
  });

  it("formats the short form and keeps a property named type", () => {
    const src = `relationship   R {
type String
  at DateTime?
}
node A { id String @id
x A[] @out(R) }
`;
    const out = formatSchema(src);
    expect(out).toBe(`relationship R {
  type String
  at   DateTime?
}

node A {
  id String @id
  x  A[]    @out(R)
}
`);
    expect(formatSchema(out)).toBe(out);
  });
});
