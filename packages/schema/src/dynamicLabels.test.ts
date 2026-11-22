import { describe, expect, it } from "vitest";
import { formatSchema } from "./formatSchema.js";
import { resolveSchema } from "./model.js";
import { parseSchema } from "./parseSchema.js";
import { printSchemaDocument } from "./printSchema.js";
import { renderCyphraGenSource } from "./renderCyphraGen.js";

const SRC = `
interface Person {
  id   String @id
  name String

  @@labels([Archived])
}

node Employee implements Person {
  salary Int

  @@labels([Featured, Archived])
}

node Post {
  id    String @id
  title String

  @@labels([Archived, Featured])
}

node Tag {
  id String @id
}
`;

const model = () => resolveSchema(parseSchema(SRC));
const node = (name: string) => model().nodes.find((n) => n.name === name)!;
const resolve = (src: string) => () => resolveSchema(parseSchema(src));

describe("@@labels (dynamic labels)", () => {
  it("resolves the declared labels, interfaces' first, each once", () => {
    expect(node("Post").dynamicLabels).toEqual(["Archived", "Featured"]);
    expect(node("Person").dynamicLabels).toEqual(["Archived"]);
    expect(node("Employee").dynamicLabels).toEqual(["Archived", "Featured"]);
    // Dynamic labels are not part of how the model is matched.
    expect(node("Employee").labels).toEqual(["Employee", "Person"]);
    expect(node("Post").labels).toBeUndefined();
  });

  it("leaves models without @@labels unchanged", () => {
    expect(node("Tag")).not.toHaveProperty("dynamicLabels");
  });

  it("emits the labels in the type map only when declared", () => {
    const gen = renderCyphraGenSource(parseSchema(SRC));
    expect(gen).toMatch(
      / {2}Post: \{\n {4}scalars: Post;\n {4}dynamicLabels: "Archived" \| "Featured";/,
    );
    expect(gen).not.toMatch(/Tag: \{\n {4}scalars: Tag;\n {4}dynamicLabels/);
  });

  it("prints and formats back", () => {
    const printed = printSchemaDocument(parseSchema(SRC));
    expect(printed).toContain("  @@labels([Archived, Featured])");
    expect(resolveSchema(parseSchema(printed))).toEqual(model());
    expect(formatSchema(SRC)).toContain("@@labels([Featured, Archived])");
  });

  it("rejects invalid declarations", () => {
    expect(resolve(`node A { id String @id\n @@labels([]) }`)).toThrow(
      /needs a list of label names/,
    );
    expect(resolve(`node A { id String @id\n @@labels }`)).toThrow(/needs a list of label names/);
    expect(resolve(`node A { id String @id\n @@labels([X, X]) }`)).toThrow(/lists X twice/);
    expect(resolve(`node A { id String @id\n @@labels([X], name: "y") }`)).toThrow(
      /takes no arguments/,
    );
    expect(resolve(`node A { id String @id\n @@labels([X])\n @@labels([Y]) }`)).toThrow(
      /given 2 times/,
    );
    expect(resolve(`node A { id String @id\n @@labels([B]) }\nnode B { id String @id }`)).toThrow(
      /B is the label of node B/,
    );
    expect(resolve(`node A { id String @id\n @@labels([A]) }`)).toThrow(/A is the label of node A/);
    expect(resolve(`interface I {}\nnode A { id String @id\n @@labels([I]) }`)).toThrow(
      /label of interface I.*implements I/,
    );
    expect(resolve(`node A { id String @id\n @@labels([__Hidden]) }`)).toThrow(/reserved/);
    expect(
      resolve(
        `node A { id String @id }\nrelationship R { type "R"\n from A\n to A\n @@labels([X]) }`,
      ),
    ).toThrow(/dynamic labels are only supported on node models/);
  });
});
