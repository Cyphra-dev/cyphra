import { readFileSync } from "node:fs";
import { buildSchema, parse, subscribe, validateSchema, type ExecutionResult } from "graphql";
import { parseSchema, resolveSchema, type SchemaModel } from "@cyphra/schema";
import { describe, expect, it, vi } from "vitest";
import { CDCReader, makeSchema, NativeSchemaError, printSchema, type Change } from "./index.js";

function model(file: string | URL): SchemaModel {
  return resolveSchema(parseSchema(readFileSync(file, "utf8")));
}
const blog = model(new URL("./__fixtures__/blog.cyphra", import.meta.url));
const interfaces = model(
  new URL("../../../runtime/src/orm/__fixtures__/interfaces.cyphra", import.meta.url),
);

describe("native subscriptions: schema", () => {
  it("are off by default", () => {
    expect(printSchema(blog)).not.toContain("type Subscription");
  });

  it("prints <model>Changed and the relationship events of each readable relation", () => {
    const sdl = printSchema(blog, {
      models: {
        User: { operations: { subscribe: true }, fields: { followers: false } },
        Post: { operations: { subscribe: ["changed"] } },
        Tag: { operations: { subscribe: ["connected"] } },
      },
      naming: { Post: { changed: "postUpdates" } },
    });
    expect(validateSchema(buildSchema(sdl))).toEqual([]);
    expect(sdl).toMatch(
      /postUpdates\([\s\S]*?operations: \[ChangeOperation!\]\s*where: PostWhere\s*\): PostChange!/,
    );
    expect(sdl).toContain("userChanged(");
    expect(sdl).toContain(
      "userFollowingConnected(relatedWhere: UserWhere, where: UserWhere): UserFollowingEvent!",
    );
    expect(sdl).toContain("userFollowingDisconnected(");
    expect(sdl).toContain(
      "userPostsConnected(relatedWhere: PostWhere, where: UserWhere): UserPostsEvent!",
    );
    expect(sdl).toContain("tagPostsConnected(");
    expect(sdl).not.toContain("tagPostsDisconnected");
    expect(sdl).not.toContain("tagChanged");
    // A hidden relation has no events.
    expect(sdl).not.toContain("userFollowers");
    expect(sdl).toMatch(/type PostChange \{[^}]*changedFields: \[String!\]!/);
    expect(sdl).toMatch(/type PostChange \{[^}]*node: Post\n/);
    expect(sdl).toMatch(/type UserFollowingEvent \{[^}]*_edge: Follows\n/);
    expect(sdl).toMatch(/type UserPostsEvent \{[^}]*related: Post!/);
    expect(sdl).not.toMatch(/type UserPostsEvent \{[^}]*_edge/);
    expect(sdl).toContain("enum ChangeOperation {\n  CREATED\n  DELETED\n  UPDATED\n}");
  });

  it("serves node models only, with a key", () => {
    expect(() =>
      printSchema(interfaces, { models: { Person: { operations: { subscribe: true } } } }),
    ).toThrow(/Person is an interface; subscriptions are served on node models/);
    // From the defaults, interfaces are left out.
    const sdl = printSchema(interfaces, { defaults: { operations: { subscribe: ["changed"] } } });
    expect(sdl).toContain("type Subscription");
    expect(sdl).not.toContain("personChanged");
    expect(() =>
      printSchema(blog, {
        models: { Post: { operations: { subscribe: ["watched" as "changed"] } } },
      }),
    ).toThrow(/unknown operation "watched"/);
  });

  it("needs a CDC reader to serve them", () => {
    expect(() =>
      makeSchema({
        client: { $schema: blog },
        config: { models: { Post: { operations: { subscribe: true } } } },
      }),
    ).toThrow(NativeSchemaError);
  });

  it("checks the reader's options", () => {
    expect(() => new CDCReader({})).toThrow(/pass `driver`/);
    expect(() => new CDCReader({ driver: {} as never, pollInterval: 0 })).toThrow(/pollInterval/);
    expect(
      () => new CDCReader({ client: { dialect: "memgraph", withReadTransaction: async () => [] } }),
    ).toThrow(/dialect "memgraph"/);
  });
});

/** A reader stub: captures the listener, so a test can push batches. */
function fakeReader() {
  const listeners: { onBatch: (c: readonly Change[]) => void; onClose: () => void }[] = [];
  const reader = {
    listen: vi.fn(
      async (_interest: unknown, onBatch: (c: readonly Change[]) => void, onClose: () => void) => {
        listeners.push({ onBatch, onClose });
        return () => {};
      },
    ),
  } as unknown as CDCReader;
  return { reader, listeners };
}

const node = (
  operation: "c" | "u" | "d",
  label: string,
  before?: Record<string, unknown>,
  after?: Record<string, unknown>,
): Change => ({
  kind: "node",
  operation,
  elementId: `e-${String((after ?? before)?.id ?? (after ?? before)?.name)}`,
  labels: [label],
  ...(before ? { before } : {}),
  ...(after ? { after } : {}),
});

async function events(iterator: AsyncIterator<ExecutionResult>, count: number): Promise<unknown[]> {
  const out: unknown[] = [];
  for (let i = 0; i < count; i++) out.push((await iterator.next()).value);
  return out;
}

describe("native subscriptions: re-reads", () => {
  it("re-reads every batch with the subscription's where, and keeps DELETED to delivered nodes", async () => {
    const findMany = vi.fn(async (_args: unknown) => [{ id: "p1", title: "One" }]);
    const { reader, listeners } = fakeReader();
    const schema = makeSchema({
      client: { $schema: blog, post: { findMany } },
      config: { models: { Post: { operations: { subscribe: ["changed"] } } } },
      subscriptions: reader,
    });
    const result = await subscribe({
      schema,
      document: parse(
        `subscription { postChanged(where: { published: { equals: true } }) { operation id node { title } changedFields } }`,
      ),
      contextValue: {},
    });
    if (!(Symbol.asyncIterator in result)) throw new Error(JSON.stringify(result.errors));
    const iterator = result[Symbol.asyncIterator]();
    listeners[0]!.onBatch([
      node("c", "Post", undefined, { id: "p1", title: "One" }),
      node("u", "Post", { id: "p2", title: "a" }, { id: "p2", title: "b" }),
      node("d", "Post", { id: "p3", title: "Three" }),
      node("c", "Tag", undefined, { name: "x" }),
    ]);
    listeners[0]!.onBatch([node("d", "Post", { id: "p1", title: "One" })]);
    expect(await events(iterator, 2)).toEqual([
      {
        data: {
          postChanged: {
            operation: "CREATED",
            id: "p1",
            node: { title: "One" },
            changedFields: [],
          },
        },
      },
      // p2 is not re-read (filtered out), p3 never delivered: only p1's delete.
      { data: { postChanged: { operation: "DELETED", id: "p1", node: null, changedFields: [] } } },
    ]);
    // One statement per batch with a node to re-read, by key, with the selection.
    expect(findMany).toHaveBeenCalledTimes(1);
    const args = findMany.mock.calls[0]![0] as { where: { AND: unknown[] }; select: unknown };
    expect(args.where.AND[0]).toEqual({ id: { in: ["p1", "p2"] } });
    expect(args.where.AND).toHaveLength(2);
    expect(args.select).toEqual({ title: true, id: true });
    await iterator.return?.();
  });

  it("delivers every DELETED and changedFields without a where or a read rule", async () => {
    const findMany = vi.fn(async () => [{ id: "u1", name: "New", email: "a@b.c" }]);
    const { reader, listeners } = fakeReader();
    const schema = makeSchema({
      client: { $schema: blog, user: { findMany } },
      config: {
        models: {
          User: { operations: { subscribe: ["changed"] }, fields: { passwordHash: false } },
        },
      },
      subscriptions: reader,
    });
    const result = await subscribe({
      schema,
      document: parse(
        `subscription { userChanged(operations: [UPDATED, DELETED]) { op: operation id changedFields } }`,
      ),
      contextValue: {},
    });
    if (!(Symbol.asyncIterator in result)) throw new Error(JSON.stringify(result.errors));
    const iterator = result[Symbol.asyncIterator]();
    listeners[0]!.onBatch([
      node("c", "User", undefined, { id: "u0" }),
      node(
        "u",
        "User",
        { id: "u1", name: "Old", email: "a@b.c", passwordHash: "x" },
        { id: "u1", name: "New", email: "a@b.c", passwordHash: "y" },
      ),
      node("d", "User", { id: "u9" }),
    ]);
    expect(await events(iterator, 2)).toEqual([
      // passwordHash is hidden by the config: not named in changedFields.
      { data: { userChanged: { op: "UPDATED", id: "u1", changedFields: ["name"] } } },
      { data: { userChanged: { op: "DELETED", id: "u9", changedFields: [] } } },
    ]);
    await iterator.return?.();
  });
});
