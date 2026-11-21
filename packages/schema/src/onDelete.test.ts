import { describe, expect, it } from "vitest";
import { parseSchema } from "./parseSchema.js";
import { printSchemaDocument } from "./printSchema.js";
import { formatSchema } from "./formatSchema.js";
import { resolveSchema, type ResolvedRelationField } from "./model.js";

const resolve = (src: string) => resolveSchema(parseSchema(src));

function rel(src: string, node: string, field: string): ResolvedRelationField {
  const n = resolve(src).nodes.find((x) => x.name === node)!;
  return n.fields.find((f) => f.name === field) as ResolvedRelationField;
}

describe("@relationship(onDelete: …)", () => {
  const src = `
    node User {
      id       String    @id
      sessions Session[] @relationship(type: "HAS_SESSION", direction: OUT, onDelete: Cascade)
      notes    Note[]    @relationship(type: "WROTE", onDelete: Restrict)
      friends  User[]    @relationship(type: "KNOWS", onDelete: SetNull)
      profile  Profile?  @relationship(type: "HAS_PROFILE", onDelete: Cascade)
    }
    node Session {
      id   String @id
      user User   @relationship(type: "HAS_SESSION", direction: IN)
    }
    node Note {
      id     String @id
      author User   @relationship(type: "WROTE", direction: IN, onDelete: Cascade)
    }
    node Profile {
      id String @id
    }
  `;

  it("resolves the rule on the field (absent when not set)", () => {
    expect(rel(src, "User", "sessions").onDelete).toBe("Cascade");
    expect(rel(src, "User", "notes").onDelete).toBe("Restrict");
    expect(rel(src, "User", "friends").onDelete).toBe("SetNull");
    expect(rel(src, "User", "profile")).toMatchObject({ onDelete: "Cascade", many: false });
    expect(rel(src, "Session", "user")).not.toHaveProperty("onDelete");
    // Each side has its own rule: deleting a Note deletes its author.
    expect(rel(src, "Note", "author").onDelete).toBe("Cascade");
  });

  it("prints and formats back", () => {
    const printed = printSchemaDocument(parseSchema(src));
    expect(printed).toContain(
      '@relationship(type: "HAS_SESSION", direction: OUT, onDelete: Cascade)',
    );
    expect(resolveSchema(parseSchema(printed))).toEqual(resolve(src));
    expect(formatSchema(src)).toContain("onDelete: Restrict");
  });

  it("rejects unknown rules, strings, duplicates and unknown arguments", () => {
    const bad = (args: string) => () =>
      resolve(`node A { id String @id  bs B[] @relationship(${args}) } node B { id String @id }`);
    expect(bad(`type: "X", onDelete: Delete`)).toThrow(
      /onDelete must be Cascade, Restrict, SetNull/,
    );
    expect(bad(`type: "X", onDelete: "Cascade"`)).toThrow(/onDelete must be/);
    expect(bad(`type: "X", onDelete: Cascade, onDelete: Restrict`)).toThrow(/given twice/);
    expect(bad(`type: "X", ondelete: Cascade`)).toThrow(
      /unknown @relationship argument "ondelete"/,
    );
  });

  it("rejects two fields on the same edges with different rules", () => {
    expect(() =>
      resolve(`
        node A {
          id String @id
          bs  B[] @relationship(type: "X", onDelete: Cascade)
          bs2 B[] @relationship(type: "X", onDelete: Restrict)
        }
        node B { id String @id }
      `),
    ).toThrow(/conflicts with field "bs"/);
    // Same rule (or an IN field on the same type): fine.
    expect(() =>
      resolve(`
        node A {
          id String @id
          bs  B[] @relationship(type: "X", onDelete: Cascade)
          bs2 B[] @relationship(type: "X", onDelete: Cascade)
          cs  A[] @relationship(type: "X", direction: IN, onDelete: Restrict)
        }
        node B { id String @id }
      `),
    ).not.toThrow();
  });
});
