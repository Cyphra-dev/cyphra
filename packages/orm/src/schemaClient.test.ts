import type { CompiledCypher } from "@cyphra/query";
import type { CyphraClient } from "@cyphra/runtime";
import { parseSchema } from "@cyphra/schema";
import { validateSchema } from "@cyphra/schema";
import { describe, expect, it, vi } from "vitest";
import { createSchemaClient, modelNameToClientKey } from "./schemaClient.js";

const blogLikeSchema = `
node Author {
  id   String @id @default(cuid())
  name String
}

node Post {
  id        String @id @default(cuid())
  title     String
  slug      String @unique
  body      String
  createdAt DateTime @default(now()) @index
  author    Author? @relationship(type: "WRITTEN_BY", direction: OUT)
}
`;

describe("modelNameToClientKey", () => {
  it("lowercases and pluralizes", () => {
    expect(modelNameToClientKey("Post")).toBe("posts");
    expect(modelNameToClientKey("Author")).toBe("authors");
  });
});

describe("createSchemaClient", () => {
  it("posts.create issues CREATE with server timestamp and returns row from tx", async () => {
    const doc = parseSchema(blogLikeSchema);
    validateSchema(doc);

    const runCompiledTx = vi.fn(async () => undefined);
    const queryRecordTx = vi.fn(async () => ({ n: { id: "pid", title: "Hello" } }));

    const client = {
      withWriteTransaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({}),
      runCompiledTx,
      queryRecordTx,
    } as unknown as CyphraClient;

    const db = createSchemaClient(client, doc);
    const row = await db.posts.create({
      data: { id: "pid", title: "Hello", slug: "hello", body: "…" },
    });

    expect(runCompiledTx).toHaveBeenCalledTimes(1);
    const first = (runCompiledTx.mock.calls[0] as unknown as [unknown, CompiledCypher])[1];
    expect(first.text).toContain("CREATE (n:Post)");
    expect(first.text).toContain("n.createdAt = datetime()");
    expect(first.params.props).toMatchObject({
      id: "pid",
      title: "Hello",
      slug: "hello",
      body: "…",
    });
    expect(first.params.props).not.toHaveProperty("createdAt");
    expect(queryRecordTx).toHaveBeenCalledTimes(1);
    expect(row).toEqual({ n: { id: "pid", title: "Hello" } });
  });

  it("posts.create with nested author.create compiles linked CREATE", async () => {
    const doc = parseSchema(blogLikeSchema);
    validateSchema(doc);

    const runCompiledTx = vi.fn(async () => undefined);
    const queryRecordTx = vi.fn(async () => ({ n: { id: "p1" } }));

    const client = {
      withWriteTransaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({}),
      runCompiledTx,
      queryRecordTx,
    } as unknown as CyphraClient;

    const db = createSchemaClient(client, doc);
    await db.posts.create({
      data: {
        id: "p1",
        title: "T",
        slug: "s",
        body: "b",
        author: { create: { name: "Ada" } },
      },
    });

    const write = (runCompiledTx.mock.calls[0] as unknown as [unknown, CompiledCypher])[1];
    expect(write.text).toContain("CREATE (n:Post)");
    expect(write.text).toContain("CREATE (m:Author)");
    expect(write.text).toContain("CREATE (n)-[r:WRITTEN_BY]->(m)");
    expect(write.params).toHaveProperty("f1_props");
  });

  it("posts.create with nested author.connect matches existing Author then links", async () => {
    const doc = parseSchema(blogLikeSchema);
    validateSchema(doc);

    const runCompiledTx = vi.fn(async () => undefined);
    const queryRecordTx = vi.fn(async () => ({ n: { id: "p2" } }));

    const client = {
      withWriteTransaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({}),
      runCompiledTx,
      queryRecordTx,
    } as unknown as CyphraClient;

    const db = createSchemaClient(client, doc);
    await db.posts.create({
      data: {
        id: "p2",
        title: "T",
        slug: "s2",
        body: "b",
        author: { connect: { id: "existing-author" } },
      },
    });

    const write = (runCompiledTx.mock.calls[0] as unknown as [unknown, CompiledCypher])[1];
    expect(write.text).toContain("MATCH (m:Author)");
    expect(write.text).toContain("CREATE (n:Post)");
    expect(write.text).toContain("CREATE (n)-[r:WRITTEN_BY]->(m)");
  });

  it("posts.findMany with include runs compileRootOptionalOutgoingSelect-shaped read", async () => {
    const doc = parseSchema(blogLikeSchema);
    validateSchema(doc);

    const queryRecords = vi.fn(async () => [
      {
        root: { id: "p1", title: "Hi", slug: "hi", body: "…", createdAt: "t" },
        included: { id: "a1", name: "Ada" },
      },
    ]);

    const client = {
      withSession: async (fn: (s: unknown) => Promise<unknown>) => fn({}),
      queryRecords,
    } as unknown as CyphraClient;

    const db = createSchemaClient(client, doc);
    const rows = await db.posts.findMany({
      include: { author: true },
      orderBy: { field: "createdAt", direction: "desc" },
      skip: 1,
      take: 2,
    });

    expect(queryRecords).toHaveBeenCalledTimes(1);
    const compiled = (queryRecords.mock.calls[0] as unknown as [unknown, CompiledCypher])[1];
    expect(compiled.text).toContain("OPTIONAL MATCH");
    expect(compiled.text).toContain("WRITTEN_BY");
    expect(compiled.text).toContain("SKIP");
    expect(compiled.text).toContain("LIMIT");
    expect(rows).toEqual([
      {
        id: "p1",
        title: "Hi",
        slug: "hi",
        body: "…",
        createdAt: "t",
        author: { id: "a1", name: "Ada" },
      },
    ]);
  });
});
