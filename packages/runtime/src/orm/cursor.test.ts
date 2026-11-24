import { describe, expect, it } from "vitest";
import neo4j from "neo4j-driver";
import { schemaModel } from "./__fixtures__/blog.gen.js";
import { schemaModel as unionSchema } from "./__fixtures__/unions.gen.js";
import { ModelEngine, type Executor, type Runner } from "./engine.js";
import { CyphraValidationError } from "./errors.js";
import { QueryContext, compileSortKeys, type SortKey } from "./compile.js";
import {
  cursorSortKeys,
  decodeCursor,
  encodeCursor,
  keysetPredicate,
  orderFingerprint,
} from "./cursor.js";

type Call = { text: string; params: Record<string, unknown> };

function engine(
  name: string,
  answer: (text: string) => Record<string, unknown>[] = () => [],
  schema = schemaModel,
) {
  const calls: Call[] = [];
  const exec: Executor = async (text, params) => {
    calls.push({ text, params });
    return answer(text);
  };
  const runner: Runner = { read: (fn) => fn(exec), write: (fn) => fn(exec) };
  const model = schema.nodes.find((n) => n.name === name)!;
  return { calls, e: new ModelEngine(schema, model, runner) };
}

const post = schemaModel.nodes.find((n) => n.name === "Post")!;
const user = schemaModel.nodes.find((n) => n.name === "User")!;

const created = (iso: string) => neo4j.types.DateTime.fromStandardDate(new Date(iso));

/** A `findMany` row as the projection returns it, with its sort keys. */
function postRow(id: string, views: number, extra: Record<string, unknown> = {}) {
  return {
    row: { id, title: id, views: neo4j.int(views), ...extra },
    __cursor: [neo4j.int(views), id],
  };
}

describe("keyset predicates", () => {
  const keys = (dirs: ("ASC" | "DESC")[]): SortKey[] =>
    dirs.map((dir, i) => ({ expr: `e${i}`, dir, value: { kind: "text" } }));

  it("expands to one branch per key, ties broken by the next keys", () => {
    expect(keysetPredicate(keys(["ASC", "ASC"]), ["k0", "k1"], ["$a", "$b"], "after")).toBe(
      "((k0 > $a OR k0 IS NULL)) OR (k0 = $a AND (k1 > $b OR k1 IS NULL))",
    );
    expect(keysetPredicate(keys(["DESC", "ASC"]), ["k0", "k1"], ["$a", "$b"], "after")).toBe(
      "(k0 < $a) OR (k0 = $a AND (k1 > $b OR k1 IS NULL))",
    );
    expect(keysetPredicate(keys(["DESC", "ASC"]), ["k0", "k1"], ["$a", "$b"], "before")).toBe(
      "((k0 > $a OR k0 IS NULL)) OR (k0 = $a AND k1 < $b)",
    );
  });

  it("places nulls last ascending and first descending", () => {
    // After a null (ascending): only the other nulls, by the next key.
    expect(keysetPredicate(keys(["ASC", "ASC"]), ["k0", "k1"], [null, "$b"], "after")).toBe(
      "(k0 IS NULL AND (k1 > $b OR k1 IS NULL))",
    );
    // After a null (descending): every non-null value.
    expect(keysetPredicate(keys(["DESC", "ASC"]), ["k0", "k1"], [null, "$b"], "after")).toBe(
      "(k0 IS NOT NULL) OR (k0 IS NULL AND (k1 > $b OR k1 IS NULL))",
    );
    expect(keysetPredicate(keys(["ASC"]), ["k0"], [null], "after")).toBe("false");
  });
});

describe("cursor encoding", () => {
  it("round-trips the sort key values, typed (DateTime, Int, String)", () => {
    const ctx = new QueryContext(schemaModel);
    const orderBy = [{ createdAt: "desc" }, { age: "asc" }];
    const keys = cursorSortKeys(ctx, user, "n", orderBy);
    expect(keys.map((k) => `${k.expr} ${k.dir}`)).toEqual([
      "n.`createdAt` DESC",
      "n.`age` ASC",
      "n.`id` ASC",
    ]);
    const print = orderFingerprint(user, orderBy);
    const cursor = encodeCursor(print, keys, [created("2024-05-01T10:00:00Z"), null, "u1"]);
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    const params = decodeCursor(new QueryContext(schemaModel), user, print, keys, cursor, "after");
    expect(params).toEqual(["$p0", null, "$p1"]);
    const decodeCtx = new QueryContext(schemaModel);
    decodeCursor(decodeCtx, user, print, keys, cursor, "after");
    expect(String(decodeCtx.params.p0)).toBe("2024-05-01T10:00:00Z");
    expect(decodeCtx.params.p1).toBe("u1");
  });

  it("rejects malformed cursors and cursors of another model or orderBy", () => {
    const ctx = new QueryContext(schemaModel);
    const keys = cursorSortKeys(ctx, post, "n", { views: "desc" });
    const print = orderFingerprint(post, { views: "desc" });
    const cursor = encodeCursor(print, keys, [neo4j.int(3), "p1"]);
    const bad =
      (c: string, p = print, k = keys) =>
      () =>
        decodeCursor(new QueryContext(schemaModel), post, p, k, c, "after");
    expect(bad("not a cursor!")).toThrow(CyphraValidationError);
    expect(bad("eyJ4IjoxfQ")).toThrow(/not a valid cursor/);
    // Another orderBy (or the same orderBy of another model) has another fingerprint.
    expect(bad(cursor, orderFingerprint(post, { views: "asc" }))).toThrow(/not a valid cursor/);
    expect(bad(cursor, orderFingerprint(user, { views: "desc" }))).toThrow(/not a valid cursor/);
    // A tampered value of the wrong type.
    const tampered = Buffer.from(JSON.stringify([1, print, ["three", "p1"]])).toString("base64url");
    expect(bad(tampered)).toThrow(/not a valid cursor/);
  });

  it("keys relation counts, related scalars and __typename by their kind", () => {
    const ctx = new QueryContext(schemaModel);
    const keys = compileSortKeys(ctx, post, "n", [{ author: { name: "asc" } }]);
    expect(keys[0]!.value).toMatchObject({ kind: "scalar", owner: "User" });
    const userKeys = compileSortKeys(ctx, user, "n", { posts: { _count: "desc" } });
    expect(userKeys[0]!.value).toEqual({ kind: "count" });
  });

  it("uses the element id as tiebreaker on a model without @id (a union)", () => {
    const union = unionSchema.nodes.find((n) => n.union)!;
    const keys = cursorSortKeys(new QueryContext(unionSchema), union, "n", undefined);
    expect(keys.map((k) => k.expr)).toEqual(["elementId(n)"]);
  });
});

describe("findMany with cursors", () => {
  it("binds the sort keys once, keeps the nodes after the cursor, and returns $cursor", async () => {
    const { calls, e } = engine("Post", () => [postRow("p2", 5), postRow("p3", 5)]);
    const page = await e.findMany({
      orderBy: { views: "desc" },
      take: 2,
      select: { id: true, $cursor: true },
    });
    expect(calls[0]!.text).toBe(
      "MATCH (n:`Post`) WITH n, n.`views` AS k0, n.`id` AS k1 WITH n, k0, k1 ORDER BY k0 DESC, k1 ASC" +
        " LIMIT $p0 RETURN n{.`id`} AS row, [k0, k1] AS __cursor ORDER BY k0 DESC, k1 ASC",
    );
    expect(page.map((r) => r.id)).toEqual(["p2", "p3"]);
    expect(typeof page[1]!.$cursor).toBe("string");

    const next = engine("Post", () => []);
    await next.e.findMany({
      orderBy: { views: "desc" },
      take: 2,
      cursor: { after: page[1]!.$cursor },
    });
    expect(next.calls[0]!.text).toBe(
      "MATCH (n:`Post`) WITH n, n.`views` AS k0, n.`id` AS k1" +
        " WHERE (k0 < $p0) OR (k0 = $p0 AND (k1 > $p1 OR k1 IS NULL))" +
        " WITH n, k0, k1 ORDER BY k0 DESC, k1 ASC LIMIT $p2" +
        " RETURN n{.`id`, .`title`, .`published`, .`views`, .`score`, .`publishedOn`} AS row ORDER BY k0 DESC, k1 ASC",
    );
    expect(String(next.calls[0]!.params.p0)).toBe("5");
    expect(next.calls[0]!.params.p1).toBe("p3");
  });

  it("pages backwards with only `before`: reversed for LIMIT, restored for the result", async () => {
    const { e: first } = engine("Post", () => [postRow("p9", 1)]);
    const [row] = await first.findMany({ orderBy: { views: "desc" }, include: { $cursor: true } });
    const { calls, e } = engine("Post");
    await e.findMany({
      orderBy: { views: "desc" },
      take: 3,
      skip: 1,
      cursor: { before: row!.$cursor },
    });
    expect(calls[0]!.text).toContain(
      "WHERE ((k0 > $p0 OR k0 IS NULL)) OR (k0 = $p0 AND k1 < $p1) WITH n, k0, k1 ORDER BY k0 ASC, k1 DESC SKIP $p2 LIMIT $p3",
    );
    expect(calls[0]!.text).toMatch(/ORDER BY k0 DESC, k1 ASC$/);
  });

  it("combines after and before (forward order)", async () => {
    const { e: first } = engine("Post", () => [postRow("a", 9), postRow("b", 1)]);
    const rows = await first.findMany({ orderBy: { views: "desc" }, select: { $cursor: true } });
    const { calls, e } = engine("Post");
    await e.findMany({
      orderBy: { views: "desc" },
      cursor: { after: rows[0]!.$cursor, before: rows[1]!.$cursor },
    });
    expect(calls[0]!.text).toContain(") AND (");
    expect(calls[0]!.text).toContain("ORDER BY k0 DESC, k1 ASC RETURN");
  });

  it("findFirst passes cursors through; findUnique ignores them", async () => {
    const { e: first } = engine("Post", () => [postRow("a", 9)]);
    const [row] = await first.findMany({ orderBy: { views: "asc" }, select: { $cursor: true } });
    const { calls, e } = engine("Post");
    await e.findFirst({ orderBy: { views: "asc" }, cursor: { after: row!.$cursor } });
    expect(calls[0]!.text).toContain("WHERE ((k0 > $p0 OR k0 IS NULL))");
    expect(calls[0]!.text).toContain("LIMIT");
    await e.findUnique({ where: { id: "x" }, cursor: { after: "garbage" } } as never);
    expect(calls[1]!.text).not.toContain("k0");
  });

  it("rejects a cursor of another orderBy, malformed cursor args and nested $cursor", async () => {
    const { e: first } = engine("Post", () => [postRow("a", 9)]);
    const [row] = await first.findMany({ orderBy: { views: "desc" }, select: { $cursor: true } });
    const { calls, e } = engine("Post");
    await expect(
      e.findMany({ orderBy: { views: "asc" }, cursor: { after: row!.$cursor } }),
    ).rejects.toThrow(/cursor.after is not a valid cursor/);
    await expect(e.findMany({ cursor: "abc" })).rejects.toThrow(CyphraValidationError);
    await expect(e.findMany({ cursor: { first: "abc" } })).rejects.toThrow(/unknown key "first"/);
    await expect(e.findMany({ cursor: { after: 3 } })).rejects.toThrow(/must be a cursor string/);
    await expect(e.findMany({ select: { $cursor: "yes" } })).rejects.toThrow(/\$cursor takes true/);
    const u = engine("User");
    await expect(
      u.e.findMany({ select: { posts: { select: { $cursor: true } } } }),
    ).rejects.toThrow(/Unknown field "Post.\$cursor"/);
    expect(calls).toHaveLength(0);
  });

  it("keeps the plain statement when no cursor is involved", async () => {
    const { calls, e } = engine("Post");
    await e.findMany({ orderBy: { views: "desc" }, take: 2 });
    expect(calls[0]!.text).toBe(
      "MATCH (n:`Post`) WITH n ORDER BY n.`views` DESC LIMIT $p0" +
        " RETURN n{.`id`, .`title`, .`published`, .`views`, .`score`, .`publishedOn`} AS row ORDER BY n.`views` DESC",
    );
  });
});
