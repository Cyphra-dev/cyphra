import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runImportGraphql } from "./importGraphql.js";

const TYPEDEFS = `
scalar Rating
type Movie @node {
  id: ID! @id
  title: String!
  runtime: Rating
  actors: [Person!]! @relationship(type: "ACTED_IN", direction: IN, properties: "ActedIn")
}
type Person @node {
  name: String!
  movies: [Movie!]! @relationship(type: "ACTED_IN", direction: OUT, properties: "ActedIn")
}
type ActedIn @relationshipProperties {
  roles: [String!]!
}
`;

describe("cyphra import graphql", () => {
  let dir: string;
  let out: string[];
  let err: string[];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cyphra-import-"));
    out = [];
    err = [];
    vi.spyOn(console, "log").mockImplementation((m: unknown) => void out.push(String(m)));
    vi.spyOn(console, "warn").mockImplementation((m: unknown) => void err.push(String(m)));
    vi.spyOn(console, "error").mockImplementation((m: unknown) => void err.push(String(m)));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("writes schema.cyphra, prints the report and exits 0 with warnings", async () => {
    await writeFile(join(dir, "typeDefs.graphql"), TYPEDEFS);
    expect(await runImportGraphql(dir, ["typeDefs.graphql"])).toBe(0);
    const schema = await readFile(join(dir, "schema.cyphra"), "utf8");
    expect(schema).toContain("node Movie {");
    expect(schema).toContain("relationship ActedIn {");
    expect(schema).toContain("// runtime: Rating (not converted: type not supported)");
    expect(out.join("\n")).toBe("Wrote schema.cyphra (2 node(s), 1 relationship model(s))");
    const report = err.join("\n");
    expect(report).toContain("Not converted (2):");
    expect(report).toMatch(/Movie\.runtime\s+Rating: custom scalars are not supported/);
    expect(report).toContain("Converted with differences (1):");
  });

  it("uses the schema path from cyphra.json and --out", async () => {
    await writeFile(join(dir, "a.graphql"), "type A @node { x: Int }");
    await writeFile(join(dir, "b.graphql"), "type B @node { y: Int }");
    await writeFile(
      join(dir, "cyphra.json"),
      JSON.stringify({ schema: "./db/model.cyphra", migrations: "./migrations" }),
    );
    await import("node:fs/promises").then((fs) => fs.mkdir(join(dir, "db")));
    expect(await runImportGraphql(dir, ["a.graphql", "b.graphql"])).toBe(0);
    expect(await readFile(join(dir, "db/model.cyphra"), "utf8")).toContain("node B {");
    expect(err.join("\n")).toBe("Everything was converted.");
    expect(await runImportGraphql(dir, ["a.graphql"], { out: "other.cyphra" })).toBe(0);
    expect(await readFile(join(dir, "other.cyphra"), "utf8")).toContain("node A {");
  });

  it("exits 1 on invalid SDL and writes nothing", async () => {
    await writeFile(join(dir, "bad.graphql"), "type Movie @node {\n  title: \n}\n");
    expect(await runImportGraphql(dir, ["bad.graphql"])).toBe(1);
    expect(err.join("\n")).toMatch(/^Invalid type definitions: bad\.graphql:3:1: Syntax Error/);
    await expect(readFile(join(dir, "schema.cyphra"), "utf8")).rejects.toThrow();
  });

  it("exits 1 on a missing file", async () => {
    expect(await runImportGraphql(dir, ["nope.graphql"])).toBe(1);
    expect(err.join("\n")).toBe("Cannot read nope.graphql.");
  });

  it("refuses to overwrite without --force or --merge", async () => {
    await writeFile(join(dir, "t.graphql"), TYPEDEFS);
    await writeFile(join(dir, "schema.cyphra"), "node Keep {\n  x Int?\n}\n");
    expect(await runImportGraphql(dir, ["t.graphql"])).toBe(1);
    expect(err.join("\n")).toMatch(/already exists: pass --merge/);
    expect(await runImportGraphql(dir, ["t.graphql"], { force: true })).toBe(0);
    expect(await readFile(join(dir, "schema.cyphra"), "utf8")).not.toContain("Keep");
  });

  it("--merge keeps the existing schema", async () => {
    await writeFile(join(dir, "t.graphql"), TYPEDEFS);
    await writeFile(join(dir, "schema.cyphra"), "// mine\nnode Keep {\n  x Int?\n}\n");
    expect(await runImportGraphql(dir, ["t.graphql"], { merge: true })).toBe(0);
    const schema = await readFile(join(dir, "schema.cyphra"), "utf8");
    expect(schema.startsWith("// mine\nnode Keep {\n  x Int?\n}\n")).toBe(true);
    expect(schema).toContain("node Movie {");
    expect(out.join("\n")).toMatch(/^Merged into schema\.cyphra/);
  });

  it("--print writes the schema to stdout and the report to stderr", async () => {
    await writeFile(join(dir, "t.graphql"), TYPEDEFS);
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    expect(await runImportGraphql(dir, ["t.graphql"], { print: true })).toBe(0);
    expect(String(write.mock.calls[0]![0])).toContain("node Movie {");
    expect(err.join("\n")).toContain("Not converted (2):");
  });

  it("--id-fields marks the fields @id and --add-interface-labels maps interfaces", async () => {
    await writeFile(
      join(dir, "t.graphql"),
      `interface Production { title: String! }
type Movie implements Production @node { id: ID! title: String! }
type Series implements Production @node { id: ID! title: String! }
`,
    );
    const opts = { idFields: ["Movie.id", "Series.id"], addInterfaceLabels: true };
    expect(await runImportGraphql(dir, ["t.graphql"], opts)).toBe(0);
    const schema = await readFile(join(dir, "schema.cyphra"), "utf8");
    expect(schema).toContain("interface Production {\n  title String\n}");
    expect(schema).toContain("node Movie implements Production {\n  id String @id\n}");
    const report = err.join("\n");
    expect(report).toMatch(/Movie\.id\s+--id-fields: hinted with --id-fields: marked @id/);
    expect(report).toContain("MATCH (n:Movie) SET n:Production");
  });

  it("--url exits 1 when the database cannot be read", async () => {
    await writeFile(join(dir, "t.graphql"), TYPEDEFS);
    const env = { ...process.env };
    delete process.env.NEO4J_USERNAME;
    delete process.env.NEO4J_USER;
    delete process.env.NEO4J_PASSWORD;
    try {
      expect(await runImportGraphql(dir, ["t.graphql"], { url: "bolt://localhost:1" })).toBe(1);
    } finally {
      process.env = env;
    }
    expect(err.join("\n")).toMatch(/^Cannot read the database's constraints: Give the credentials/);
    await expect(readFile(join(dir, "schema.cyphra"), "utf8")).rejects.toThrow();
  });
});
