import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig, type CyphraConfig } from "./config.js";
import { runSchemaDdl } from "./commands/schemaDdl.js";

describe("runSchemaDdl", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prints constraint, range, vector and full-text index lines in push order", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cyphra-ddl-"));
    const schemaPath = join(dir, "schema.cyphra");
    await writeFile(
      schemaPath,
      `node U {
  id   String @id
  slug String @index
  bio  String?
  embedding Vector(3)? @vectorIndex(similarity: cosine)

  @@fulltext([slug, bio], name: "uSearch", analyzer: "english")
}
`,
      "utf8",
    );
    const config: CyphraConfig = {
      schema: schemaPath,
      migrations: join(dir, "migrations"),
      generate: join(dir, "cyphra.gen.ts"),
      runtimeImport: "cyphra",
    };
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((msg: unknown) => {
      lines.push(String(msg));
    });
    await runSchemaDdl(config);
    const joined = lines.join("\n");
    expect(joined).toMatch(/CREATE CONSTRAINT.*U.*id/s);
    expect(joined).toMatch(/CREATE RANGE INDEX.*slug/s);
    const cIdx = lines.findIndex((l) => l.includes("CREATE CONSTRAINT"));
    const iIdx = lines.findIndex((l) => l.includes("CREATE RANGE INDEX"));
    expect(cIdx).toBeGreaterThanOrEqual(0);
    expect(iIdx).toBeGreaterThan(cIdx);
    expect(lines.at(-1)).toBe(
      "CREATE FULLTEXT INDEX uSearch IF NOT EXISTS FOR (n:`U`) ON EACH [n.`slug`, n.`bio`] OPTIONS {indexConfig: {`fulltext.analyzer`: 'english'}}",
    );
    expect(lines.at(-2)).toBe(
      "CREATE VECTOR INDEX U_embedding_vector IF NOT EXISTS FOR (n:`U`) ON n.`embedding` OPTIONS {indexConfig: {`vector.dimensions`: 3, `vector.similarity_function`: 'cosine'}}",
    );
  });

  it('prints Memgraph DDL with "dialect": "memgraph"', async () => {
    const dir = await mkdtemp(join(tmpdir(), "cyphra-ddl-mg-"));
    await writeFile(
      join(dir, "schema.cyphra"),
      `node U {
  id   String @id
  slug String @index
  embedding Vector(3)? @vectorIndex(similarity: euclidean)
}
`,
      "utf8",
    );
    await writeFile(
      join(dir, "cyphra.json"),
      JSON.stringify({
        schema: "./schema.cyphra",
        migrations: "./migrations",
        dialect: "memgraph",
      }),
      "utf8",
    );
    const config = await loadConfig(dir);
    expect(config.dialect).toBe("memgraph");
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((msg: unknown) => {
      lines.push(String(msg));
    });
    await runSchemaDdl(config);
    expect(lines).toEqual([
      "CREATE CONSTRAINT ON (n:`U`) ASSERT n.`id` IS UNIQUE",
      "CREATE INDEX ON :`U`(`slug`)",
      'CREATE VECTOR INDEX `U_embedding_vector` ON :`U`(`embedding`) WITH CONFIG {"dimension": 3, "capacity": 1000, "metric": "l2sq"}',
    ]);
  });

  it('prints FalkorDB DDL with "dialect": "falkordb"', async () => {
    const dir = await mkdtemp(join(tmpdir(), "cyphra-ddl-fk-"));
    await writeFile(
      join(dir, "schema.cyphra"),
      `node U {
  id   String @id
  slug String @index
  bio  String?
  embedding Vector(3)? @vectorIndex(similarity: euclidean)

  @@fulltext([slug, bio], name: "uSearch")
}
`,
      "utf8",
    );
    await writeFile(
      join(dir, "cyphra.json"),
      JSON.stringify({
        schema: "./schema.cyphra",
        migrations: "./migrations",
        dialect: "falkordb",
      }),
      "utf8",
    );
    const config = await loadConfig(dir);
    expect(config.dialect).toBe("falkordb");
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((msg: unknown) => {
      lines.push(String(msg));
    });
    await runSchemaDdl(config);
    expect(lines).toEqual([
      "GRAPH.CONSTRAINT CREATE UNIQUE NODE `U` PROPERTIES 1 `id`",
      "CREATE INDEX FOR (n:`U`) ON (n.`slug`)",
      "CREATE VECTOR INDEX FOR (n:`U`) ON (n.`embedding`) OPTIONS {dimension: 3, similarityFunction: 'euclidean'}",
      "CREATE FULLTEXT INDEX FOR (n:`U`) ON (n.`slug`, n.`bio`)",
    ]);
  });

  it("rejects an unknown dialect in cyphra.json", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cyphra-ddl-bad-"));
    await writeFile(
      join(dir, "cyphra.json"),
      JSON.stringify({ schema: "./schema.cyphra", migrations: "./migrations", dialect: "kuzu" }),
      "utf8",
    );
    await expect(loadConfig(dir)).rejects.toThrow(
      'cyphra.json "dialect" must be "neo4j", "memgraph" or "falkordb"',
    );
  });
});
