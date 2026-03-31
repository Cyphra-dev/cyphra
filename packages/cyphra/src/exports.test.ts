import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Driver } from "@cyphra/runtime";
import { describe, expect, it, vi } from "vitest";
import {
  bareVar,
  callSubqueryCompiled,
  compileCaseExpression,
  compileComprehensionFilterClause,
  compileCreateLinkedNodes,
  createSchemaClient,
  createFluentQueryRoot,
  compileCreateRelationship,
  compileCreateRelationshipIn,
  compileRootOptionalOutgoingSelect,
  compileDeleteRelationshipWhere,
  compileMergeRelationship,
  compileMergeRelationshipIn,
  compileRemoveRelationshipProperties,
  compileSetRelationshipWhere,
  compileLoadCsvFrom,
  concatCompiledCypher,
  constraintStatementsFromSchema,
  loadConfig,
  loadConfigSync,
  loadCyphraWorkspace,
  matchHintUsingIndex,
  matchHintUsingJoin,
  matchHintUsingScan,
  createNodeCrud,
  cypher,
  CyphraClient,
  CyphraQueryError,
  defineMigration,
  exists,
  orm,
  parseSchema,
  parseSchemaFile,
  query,
  queryRecordsRootOptionalOutgoing,
  queryRelatedNodes,
  runCompiledBatchWrite,
  modelNameToClientKey,
  runCreateLinkedNodesTx,
} from "./index.js";

describe("cyphra package barrel", () => {
  it("re-exports schema, query, runtime, and migrator APIs", () => {
    expect(typeof parseSchema).toBe("function");
    expect(typeof parseSchemaFile).toBe("function");
    expect(typeof cypher).toBe("function");
    expect(typeof CyphraQueryError).toBe("function");
    expect(CyphraClient).toBeDefined();
    expect(typeof defineMigration).toBe("function");
    expect(typeof createNodeCrud).toBe("function");
    expect(typeof runCompiledBatchWrite).toBe("function");
    expect(typeof runCreateLinkedNodesTx).toBe("function");
    expect(typeof queryRecordsRootOptionalOutgoing).toBe("function");
    expect(typeof compileRootOptionalOutgoingSelect).toBe("function");
    expect(typeof compileCreateLinkedNodes).toBe("function");
    expect(typeof createSchemaClient).toBe("function");
    expect(typeof modelNameToClientKey).toBe("function");
    expect(typeof queryRelatedNodes).toBe("function");
    expect(typeof exists).toBe("function");
    expect(typeof callSubqueryCompiled).toBe("function");
    expect(typeof compileLoadCsvFrom).toBe("function");
    expect(typeof concatCompiledCypher).toBe("function");
    expect(typeof matchHintUsingIndex).toBe("function");
    expect(typeof matchHintUsingScan).toBe("function");
    expect(typeof matchHintUsingJoin).toBe("function");
    expect(typeof bareVar).toBe("function");
    expect(typeof compileComprehensionFilterClause).toBe("function");
    expect(typeof compileCaseExpression).toBe("function");
    expect(typeof compileMergeRelationship).toBe("function");
    expect(typeof compileMergeRelationshipIn).toBe("function");
    expect(typeof compileCreateRelationship).toBe("function");
    expect(typeof compileCreateRelationshipIn).toBe("function");
    expect(typeof compileDeleteRelationshipWhere).toBe("function");
    expect(typeof compileSetRelationshipWhere).toBe("function");
    expect(typeof compileRemoveRelationshipProperties).toBe("function");
    const doc = parseSchema(`node N { x String @id }`);
    expect(constraintStatementsFromSchema(doc).length).toBeGreaterThan(0);
    const compiled = cypher`RETURN 1 AS n`;
    expect(compiled.text).toContain("RETURN");
  });

  it("exposes query and orm namespaces, workspace and config loaders", () => {
    expect(typeof query.select).toBe("function");
    expect(typeof query.cypher).toBe("function");
    expect(typeof orm.createSchemaClient).toBe("function");
    expect(typeof orm.createNodeCrud).toBe("function");
    expect(typeof loadConfig).toBe("function");
    expect(typeof loadConfigSync).toBe("function");
    expect(typeof loadCyphraWorkspace).toBe("function");
    expect(typeof createFluentQueryRoot).toBe("function");
  });

  it("CyphraClient.orm lazy-loads delegates from cyphra.config + schema", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cyphra-meta-orm-"));
    await writeFile(
      join(dir, "schema.cyphra"),
      `node BlogPost { id String @id title String }\n`,
      "utf8",
    );
    await writeFile(
      join(dir, "cyphra.config.ts"),
      `export default { schema: "./schema.cyphra", migrations: { path: "./migrations" } };\n`,
      "utf8",
    );
    const driver = {
      session: vi.fn(() => ({ close: vi.fn() })),
    } as unknown as Driver;
    const { CyphraClient, CyphraNeo4j } = await import("./index.js");
    const client = new CyphraClient({
      adapter: new CyphraNeo4j({ driver }),
      projectRoot: dir,
    });
    expect(typeof client.orm.blogPosts.findMany).toBe("function");
  });

  it("re-exports parseSchemaFile", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cyphra-barrel-"));
    const path = join(dir, "s.cyphra");
    await writeFile(path, `node Z { id String @id }\n`, "utf8");
    const doc = await parseSchemaFile(path);
    expect(doc.declarations[0]).toMatchObject({ kind: "Node", name: "Z" });
  });
});
