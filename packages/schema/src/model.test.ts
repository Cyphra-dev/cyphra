import { describe, expect, it } from "vitest";
import { parseSchema } from "./parseSchema.js";
import { printSchemaDocument } from "./printSchema.js";
import { resolveSchema } from "./model.js";
import { SchemaValidationError } from "./errors.js";

const resolve = (src: string) => resolveSchema(parseSchema(src));

describe("resolveSchema", () => {
  const model = resolve(`
    node User {
      id        String   @id @default(cuid())
      email     String   @unique
      nick      String?  @default("anon")
      score     Float    @default(1.5)
      tags      String[]
      born      Date?
      createdAt DateTime @default(now())
      following User[]   @relationship(type: "FOLLOWS", direction: OUT)
      posts     Post[]   @relationship(type: "AUTHORED")
    }
    node Post {
      id     String @id
      author User?  @relationship(type: "AUTHORED", direction: IN)
    }
    relationship Follows {
      type "FOLLOWS"
      from User
      to User
      since DateTime
    }
  `);

  it("resolves scalars, defaults, lists and unique keys", () => {
    const user = model.nodes[0]!;
    expect(user.idField).toBe("id");
    expect(user.uniqueFields).toEqual(["id", "email"]);
    const byName = Object.fromEntries(user.fields.map((f) => [f.name, f]));
    expect(byName.id).toMatchObject({
      kind: "scalar",
      id: true,
      default: { kind: "fn", fn: "cuid" },
    });
    expect(byName.nick).toMatchObject({
      optional: true,
      default: { kind: "literal", value: "anon" },
    });
    expect(byName.score).toMatchObject({ type: "Float", default: { kind: "literal", value: 1.5 } });
    expect(byName.tags).toMatchObject({ list: true, optional: false });
    expect(byName.born).toMatchObject({ type: "Date", optional: true });
  });

  it("links relations, defaults direction to OUT and attaches edge models", () => {
    const [user, post] = model.nodes;
    const following = user!.fields.find((f) => f.name === "following");
    expect(following).toMatchObject({
      kind: "relation",
      target: "User",
      relType: "FOLLOWS",
      many: true,
      edge: "Follows",
    });
    const posts = user!.fields.find((f) => f.name === "posts");
    expect(posts).toMatchObject({ direction: "OUT" });
    expect(posts).not.toHaveProperty("edge");
    expect(post!.fields.find((f) => f.name === "author")).toMatchObject({
      direction: "IN",
      many: false,
      optional: true,
    });
  });

  it("round-trips the extended syntax through the printer", () => {
    const src = `node A {\n  id String @id @default(uuid())\n  tags Int[]\n  ok Boolean @default(true)\n  n Int @default(-3)\n}\n`;
    expect(printSchemaDocument(parseSchema(src))).toBe(src);
  });

  it.each([
    [`node A { b B @relationship(type: "X") }`, /unknown node "B"/],
    [`node A { b A[] }`, /Expected/],
    [`node A { b A @relationship(direction: OUT) }`, /need @relationship\(type/],
    [`node A { b A @relationship(type: "X", direction: UP) }`, /OUT or IN/],
    [`node A { id String? @id }`, /cannot be optional/],
    [`node A { n Int @default(1.5) }`, /does not match type Int/],
    [`node A { n String @default(now()) }`, /not valid for type String/],
    [`node A { n String @default(nope()) }`, /unknown default function/],
    [`node A { n String @bogus }`, /unknown decorator/],
    [`node A { x String }\nnode A { y String }`, /Duplicate declaration/],
    [`relationship R { type "R"\n from A\n to A }`, /unknown node "A"/],
  ])("rejects %s", (src, message) => {
    expect(() => resolve(src)).toThrow(message);
  });

  it("throws SchemaValidationError for semantic errors", () => {
    expect(() => resolve(`node A { b B @relationship(type: "X") }`)).toThrow(SchemaValidationError);
  });
});
