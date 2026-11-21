import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TRPCError } from "@trpc/server";
import {
  UniqueConstraintError,
  constraintStatementsFromSchema,
  indexStatementsFromSchema,
  parseSchema,
} from "cyphra";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createClient, type Db } from "./cyphra.gen";
import { httpClient } from "./http-client";
import { appRouter, createCaller } from "./router";

const { NEO4J_TEST_URI, NEO4J_TEST_USER, NEO4J_TEST_PASSWORD } = process.env;
const hasNeo = Boolean(NEO4J_TEST_URI && NEO4J_TEST_USER && NEO4J_TEST_PASSWORD);

const schemaPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../schema.cyphra",
);

async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (e) {
    if (e instanceof TRPCError) return e.code;
    throw e;
  }
  throw new Error("expected the call to fail");
}

describe.skipIf(!hasNeo)("tRPC router (Neo4j)", () => {
  let db: Db;
  let caller: ReturnType<typeof createCaller>;
  const wipe = () => db.$cypher`MATCH (n) WHERE n:User OR n:Post DETACH DELETE n`;

  beforeAll(async () => {
    db = createClient({
      uri: NEO4J_TEST_URI!,
      user: NEO4J_TEST_USER!,
      password: NEO4J_TEST_PASSWORD!,
    });
    // The constraints `cyphra push` (or a migration) creates: User.email must be unique.
    const doc = parseSchema(await readFile(schemaPath, "utf8"));
    await db.$client.withSession(async (session) => {
      for (const s of [...constraintStatementsFromSchema(doc), ...indexStatementsFromSchema(doc)]) {
        await session.run(s);
      }
      await session.run("CALL db.awaitIndexes(120)");
    });
    caller = createCaller({ db });
  });

  beforeEach(() => wipe());

  afterAll(async () => {
    if (!db) return;
    await wipe();
    await db.$disconnect();
  });

  const ada = () => caller.user.create({ name: "Ada Lovelace", email: "ada@example.com" });

  it("creates a post for an existing author", async () => {
    const author = await ada();
    const post = await caller.post.create({
      authorId: author.id,
      title: "Notes on the Analytical Engine",
      body: "It weaves algebraic patterns.",
      tags: ["history"],
    });
    expect(post).toMatchObject({
      title: "Notes on the Analytical Engine",
      status: "DRAFT",
      tags: ["history"],
      author: { id: author.id, name: "Ada Lovelace" },
    });
    expect(post.createdAt).toBeInstanceOf(Date);
  });

  it("returns NOT_FOUND for an unknown author and writes nothing", async () => {
    expect(await code(caller.post.create({ authorId: "nobody", title: "Orphan", body: "" }))).toBe(
      "NOT_FOUND",
    );
    expect(await db.post.count()).toBe(0);
  });

  it("returns CONFLICT for a duplicate email", async () => {
    await ada();
    const err = await ada().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TRPCError);
    expect(err).toMatchObject({ code: "CONFLICT", message: "Already exists (email)." });
    expect((err as TRPCError).cause).toBeInstanceOf(UniqueConstraintError);
  });

  it("lists posts with filters and pagination", async () => {
    const author = await ada();
    const other = await caller.user.create({
      name: "Charles Babbage",
      email: "charles@example.com",
    });
    for (const [i, title] of ["Engines", "Looms", "Tables", "Punched cards"].entries()) {
      await caller.post.create({
        authorId: i % 2 ? other.id : author.id,
        title,
        body: "",
        status: i < 3 ? "PUBLISHED" : "DRAFT",
        tags: i === 1 ? ["weaving"] : [],
      });
    }

    const page1 = await caller.post.list({ status: "PUBLISHED", take: 2 });
    expect(page1.total).toBe(3);
    expect(page1.items.map((p) => p.title)).toEqual(["Tables", "Looms"]);
    expect(page1.items[0]?.author).toEqual({ id: author.id, name: "Ada Lovelace" });
    expect(page1.nextSkip).toBe(2);
    const page2 = await caller.post.list({ status: "PUBLISHED", take: 2, skip: page1.nextSkip! });
    expect(page2.items.map((p) => p.title)).toEqual(["Engines"]);
    expect(page2.nextSkip).toBeNull();

    expect((await caller.post.list({ authorId: other.id })).items.map((p) => p.title)).toEqual([
      "Punched cards",
      "Looms",
    ]);
    expect((await caller.post.list({ tag: "weaving" })).total).toBe(1);
    expect((await caller.post.list({ search: "CARDS" })).items.map((p) => p.title)).toEqual([
      "Punched cards",
    ]);
  });

  it("gets a post by id with its author, or NOT_FOUND", async () => {
    const author = await ada();
    const { id } = await caller.post.create({ authorId: author.id, title: "Sketch", body: "" });
    const post = await caller.post.byId({ id });
    expect(post.author.email).toBe("ada@example.com");
    expect(await code(caller.post.byId({ id: "missing" }))).toBe("NOT_FOUND");
  });

  it("updates with the generated update schema", async () => {
    const author = await ada();
    const { id } = await caller.post.create({ authorId: author.id, title: "Draft", body: "" });
    const updated = await caller.post.update({
      id,
      data: { status: "PUBLISHED", tags: ["engine"] },
    });
    expect(updated).toMatchObject({ title: "Draft", status: "PUBLISHED", tags: ["engine"] });
    expect(await code(caller.post.update({ id, data: { title: "x" } }))).toBe("BAD_REQUEST");
    expect(await code(caller.post.update({ id: "missing", data: { title: "Gone" } }))).toBe(
      "NOT_FOUND",
    );
  });

  it("deletes a post, and a user with their posts (onDelete: Cascade)", async () => {
    const author = await ada();
    const a = await caller.post.create({ authorId: author.id, title: "First", body: "" });
    await caller.post.create({ authorId: author.id, title: "Second", body: "" });

    await caller.post.delete({ id: a.id });
    expect(await db.post.count()).toBe(1);
    expect(await code(caller.post.delete({ id: a.id }))).toBe("NOT_FOUND");

    await caller.user.delete({ id: author.id });
    expect(await db.user.count()).toBe(0);
    expect(await db.post.count()).toBe(0);
  });

  it("sends Dates through HTTP with superjson", async () => {
    const client = httpClient(appRouter, { db });
    const author = await client.user.create.mutate({
      name: "Grace Hopper",
      email: "grace@example.com",
    });
    await client.post.create.mutate({ authorId: author.id, title: "Compilers", body: "" });
    const { items } = await client.post.list.query({});
    expect(items[0]?.createdAt).toBeInstanceOf(Date);
  });
});
