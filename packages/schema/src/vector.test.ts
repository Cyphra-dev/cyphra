import { describe, expect, it } from "vitest";
import { SchemaValidationError } from "./errors.js";
import { getNodeModel, resolveSchema } from "./model.js";
import { parseSchema } from "./parseSchema.js";
import { printSchemaDocument } from "./printSchema.js";
import { renderCyphraGenSource } from "./renderCyphraGen.js";

const schema = `
node Chunk {
  id        String         @id
  text      String
  embedding Vector(1536)?  @vectorIndex(similarity: cosine)
  title     Vector(384)    @vectorIndex(similarity: euclidean, name: "chunk_title", quantization: false)
  raw       Vector(3)?
}
`;

const bad = (src: string) => () => parseSchema(src);

describe("Vector type and @vectorIndex", () => {
  it("parses Vector(N) with optionality and dimensions", () => {
    const doc = parseSchema(schema);
    const node = doc.declarations[0]!;
    expect(node.kind === "Node" && node.fields[2]).toMatchObject({
      kind: "Scalar",
      name: "embedding",
      type: { name: "Vector", optional: true, dimensions: 1536 },
      decorators: [
        {
          name: "vectorIndex",
          args: [{ key: "similarity", value: { kind: "identifier", value: "cosine" } }],
        },
      ],
    });
    expect(node.kind === "Node" && node.fields[3]).toMatchObject({
      type: { name: "Vector", optional: false, dimensions: 384 },
    });
  });

  it("resolves dimensions and the index (default name, cosine by default)", () => {
    const chunk = getNodeModel(resolveSchema(parseSchema(schema)), "Chunk");
    const field = (n: string) => chunk.fields.find((f) => f.name === n);
    expect(field("embedding")).toEqual({
      kind: "scalar",
      name: "embedding",
      type: "Vector",
      optional: true,
      list: false,
      id: false,
      unique: false,
      index: false,
      dimensions: 1536,
      vectorIndex: { name: "Chunk_embedding_vector", similarity: "cosine" },
    });
    expect(field("title")).toMatchObject({
      optional: false,
      dimensions: 384,
      vectorIndex: { name: "chunk_title", similarity: "euclidean", quantization: false },
    });
    expect(field("raw")).not.toHaveProperty("vectorIndex");
    const implicit = resolveSchema(parseSchema(`node A { v Vector(2)? @vectorIndex }`));
    expect(implicit.nodes[0]!.fields[0]).toMatchObject({
      vectorIndex: { name: "A_v_vector", similarity: "cosine" },
    });
  });

  it("does not treat a node named Vector as the vector type", () => {
    const doc = parseSchema(`
      node Vector { id String @id }
      node A { id String @id
        v Vector? @relationship(type: "HAS", direction: OUT) }
    `);
    const a = getNodeModel(resolveSchema(doc), "A");
    expect(a.fields[1]).toMatchObject({ kind: "relation", target: "Vector" });
  });

  it("validates dimensions (1..4096)", () => {
    expect(bad(`node A { v Vector(0) }`)).toThrow(/from 1 to 4096 \(got 0\)/);
    expect(bad(`node A { v Vector(4097) }`)).toThrow(SchemaValidationError);
    expect(() => parseSchema(`node A { v Vector(4096) }`)).not.toThrow();
    expect(bad(`node A { v Vector(3)[] }`)).toThrow();
  });

  it("rejects invalid decorators and arguments", () => {
    expect(bad(`node A { v Vector(3) @index }`)).toThrow(/@index is not valid on a Vector/);
    expect(bad(`node A { v Vector(3) @unique }`)).toThrow(SchemaValidationError);
    expect(bad(`node A { v Vector(3) @id }`)).toThrow(SchemaValidationError);
    expect(bad(`node A { v Float[] @vectorIndex }`)).toThrow(/only valid on Vector\(N\)/);
    expect(bad(`node A { v Vector(3) @vectorIndex(similarity: dot) }`)).toThrow(
      /cosine or euclidean/,
    );
    expect(bad(`node A { v Vector(3) @vectorIndex(similarity: "cosine") }`)).toThrow(
      /cosine or euclidean/,
    );
    expect(bad(`node A { v Vector(3) @vectorIndex(name: "has space") }`)).toThrow(/name must be/);
    expect(bad(`node A { v Vector(3) @vectorIndex(size: 3) }`)).toThrow(/unknown @vectorIndex/);
    expect(bad(`node A { v Vector(3) @vectorIndex(quantization: off) }`)).toThrow(/true or false/);
    expect(bad(`node A { v Vector(3) @vectorIndex @vectorIndex }`)).toThrow(/at most one/);
    expect(
      bad(`node A { v Vector(3) @vectorIndex(similarity: cosine, similarity: euclidean) }`),
    ).toThrow(/given twice/);
  });

  it("keeps vectors on node models", () => {
    expect(
      bad(`node A { id String @id }
        relationship R { type "R" from A to A
          v Vector(3) }`),
    ).toThrow(/only supported on node models/);
  });

  it("rejects two vector indexes with the same name", () => {
    const doc = parseSchema(`
      node A { v Vector(3) @vectorIndex(name: "same") }
      node B { w Vector(3) @vectorIndex(name: "same") }
    `);
    expect(() => resolveSchema(doc)).toThrow(/"same" is already used by A\.v/);
  });

  it("round-trips through the printer", () => {
    const a = parseSchema(schema);
    const printed = printSchemaDocument(a);
    expect(printed).toContain("embedding Vector(1536)? @vectorIndex(similarity: cosine)");
    expect(printed).toContain(
      'title Vector(384) @vectorIndex(similarity: euclidean, name: "chunk_title", quantization: false)',
    );
    expect(printed).toContain("raw Vector(3)?");
    expect(parseSchema(printed)).toEqual(a);
  });

  it("generates number[] fields and the vector keys of the type map", () => {
    const src = renderCyphraGenSource(parseSchema(schema));
    expect(src).toContain("  embedding: number[] | null;");
    expect(src).toContain("  title: number[];");
    expect(src).toContain('    createRequired: "id" | "text" | "title";');
    expect(src).toContain('    vectors: "embedding" | "title" | "raw";');
    expect(src).toContain('    vectorIndexes: "embedding" | "title";');
    expect(src).toContain('"dimensions": 1536');
    // Models without vectors generate the same type map as before.
    const plain = renderCyphraGenSource(parseSchema(`node A { id String @id }`));
    expect(plain).not.toContain("vectors:");
  });
});
