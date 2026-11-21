import { describe, expect, it } from "vitest";
import { schemaModel } from "./__fixtures__/rules.gen.js";
import { ModelEngine, type Executor, type Runner } from "./engine.js";
import { CyphraValidationError, type ValidationIssue } from "./errors.js";

type Call = { text: string; params: Record<string, unknown> };

function engine(name: string, answer: (text: string) => Record<string, unknown>[] = () => []) {
  const calls: Call[] = [];
  const exec: Executor = async (text, params) => {
    calls.push({ text, params });
    return answer(text);
  };
  const runner: Runner = { read: (fn) => fn(exec), write: (fn) => fn(exec) };
  const model = schemaModel.nodes.find((n) => n.name === name)!;
  return { calls, e: new ModelEngine(schemaModel, model, runner) };
}

/** The issues of the CyphraValidationError `p` rejects with, as `path rule` strings. */
async function issues(p: Promise<unknown>): Promise<string[]> {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(CyphraValidationError);
  return (err as CyphraValidationError).issues.map(
    (i: ValidationIssue) => `${i.path.join(".")} ${i.rule}`,
  );
}

const valid = { email: "ada@example.com", name: "Ada" };

describe("validation rules on writes", () => {
  it("collects every broken rule of create, nested creates and $edge, and runs nothing", async () => {
    const { calls, e } = engine("VrUser");
    const err = (await e
      .create({
        data: {
          email: "not-an-email",
          name: " ",
          website: "ftp://example.com",
          handle: "a b",
          age: 12,
          balance: -1n,
          score: 100.5,
          born: new Date("1899-12-31T00:00:00Z"),
          tags: ["a", "b", "c", "d"],
          posts: {
            create: [
              { title: "ok title", labels: ["x"] },
              { title: "no", $edge: { role: "too long" } },
            ],
          },
        },
      })
      .catch((x: unknown) => x)) as CyphraValidationError;
    expect(calls).toHaveLength(0);
    expect(err).toBeInstanceOf(CyphraValidationError);
    expect(err.issues.map((i) => `${i.path.join(".")} ${i.rule}`)).toEqual([
      "data.email email",
      "data.name length",
      "data.name nonEmpty",
      "data.website url",
      "data.handle regex",
      "data.age min",
      "data.balance min",
      "data.score max",
      "data.born min",
      "data.tags size",
      "data.posts.create.1.title length",
      "data.posts.create.1.labels nonEmpty",
      "data.posts.create.1.$edge.role length",
    ]);
    expect(err.issues[10]).toEqual({
      path: ["data", "posts", "create", 1, "title"],
      model: "VrPost",
      field: "title",
      rule: "length",
      message: "must be at least 3 characters long (got 2).",
    });
    expect(err.message).toContain("VrUser.create: 13 values break the schema's validation rules:");
    expect(err.message).toContain(
      "  - data.posts.create[1].title (VrPost.title): must be at least 3 characters long (got 2).",
    );
  });

  it("passes valid data through (nulls and absent optional values break no rule)", async () => {
    const { calls, e } = engine("VrUser", (t) => (t.startsWith("CREATE") ? [{ id: "1" }] : []));
    await e.create({ data: { ...valid, website: null, age: 13 } }).catch(() => undefined);
    expect(calls[0]!.text).toMatch(/^CREATE/);
  });

  it("checks a to-one nested create and the absent list of a created node", async () => {
    const { calls, e } = engine("VrPost");
    expect(
      await issues(
        e.create({
          data: { title: "Hello", labels: [], author: { create: { email: "x", name: "Al" } } },
        }),
      ),
    ).toEqual(["data.labels nonEmpty", "data.author.create.email email"]);
    expect(await issues(e.create({ data: { title: "Hello" } }))).toEqual(["data.labels nonEmpty"]);
    expect(calls).toHaveLength(0);
  });

  it("checks $edge of connect and set (only the values given)", async () => {
    const { calls, e } = engine("VrUser");
    expect(
      await issues(
        e.update({
          where: { id: "u" },
          data: {
            posts: {
              connect: [{ id: "p1", $edge: { role: "editor" } }, { id: "p2" }],
              set: [{ id: "p3", $edge: { role: "author" } }],
            },
          },
        }),
      ),
    ).toEqual(["data.posts.connect.0.$edge.role length", "data.posts.set.0.$edge.role length"]);
    expect(calls).toHaveLength(0);
  });

  it("checks update and updateMany data (only the fields given; a null list is empty)", async () => {
    const { calls, e } = engine("VrUser");
    expect(await issues(e.update({ where: { id: "u" }, data: { name: "A" } }))).toEqual([
      "data.name length",
    ]);
    expect(await issues(e.updateMany({ where: {}, data: { age: 200, email: "x@" } }))).toEqual([
      "data.email email",
      "data.age max",
    ]);
    const post = engine("VrPost");
    expect(await issues(post.e.update({ where: { id: "p" }, data: { labels: null } }))).toEqual([
      "data.labels nonEmpty",
    ]);
    expect(calls).toHaveLength(0);
    expect(post.calls).toHaveLength(0);
  });

  it("checks createMany rows by index", async () => {
    const { calls, e } = engine("VrUser");
    expect(
      await issues(e.createMany({ data: [valid, { ...valid, name: "A" }, { ...valid, age: 1 }] })),
    ).toEqual(["data.1.name length", "data.2.age min"]);
    expect(calls).toHaveLength(0);
  });

  it("checks upsert create, update and the where key", async () => {
    const { calls, e } = engine("VrUser");
    expect(
      await issues(
        e.upsert({
          where: { email: "bad" },
          create: { name: "A", posts: { create: { title: "x", labels: ["a"] } } },
          update: { score: -1 },
        }),
      ),
    ).toEqual([
      "where.email email",
      "create.name length",
      "create.posts.create.title length",
      "update.score min",
    ]);
    expect(calls).toHaveLength(0);
  });

  it("guards numeric operators on @min / @max fields in the update statement", async () => {
    const { calls, e } = engine("VrUser", (t) =>
      t.startsWith("MATCH (n:`VrUser`) WHERE") && t.includes("RETURN elementId")
        ? [{ id: "4:u" }]
        : t.includes("RETURN bad")
          ? [{ bad: ["score:max"] }]
          : [],
    );
    const err = (await e
      .update({ where: { id: "u" }, data: { score: { increment: 10, multiply: 2 } } })
      .catch((x: unknown) => x)) as CyphraValidationError;
    expect(err).toBeInstanceOf(CyphraValidationError);
    expect(err.issues).toEqual([
      {
        path: ["data", "score"],
        model: "VrUser",
        field: "score",
        rule: "max",
        message: "must be at most 100 (the update would make it larger).",
      },
    ]);
    const update = calls.find((c) => c.text.includes("RETURN bad"))!;
    expect(update.text).toBe(
      "MATCH (n) WHERE elementId(n) = $p4" +
        ' WITH n, [x IN [CASE WHEN ((n.`score` + $p0) * $p1) < $p2 THEN "score:min" END,' +
        ' CASE WHEN ((n.`score` + $p0) * $p1) > $p3 THEN "score:max" END] WHERE x IS NOT NULL] AS bad' +
        " FOREACH (x IN CASE WHEN size(bad) = 0 THEN [1] ELSE [] END" +
        " | SET n.`score` = n.`score` + $p0, n.`score` = n.`score` * $p1) RETURN bad",
    );
    expect(update.params.p2).toBe(0);
    expect(update.params.p3).toBe(100);
  });

  it("leaves operators on fields without @min / @max unguarded", async () => {
    const { calls, e } = engine("VrUser", () => [{ id: "4:u", c: 1 }]);
    await e.updateMany({ data: { tags: ["a"] } });
    expect(calls[0]!.text).toBe("MATCH (n:`VrUser`) SET n.`tags` = $p0 RETURN count(n) AS c");
  });

  it("checks every node of updateMany before updating any", async () => {
    const { calls, e } = engine("VrUser", () => [{ c: 2, bad: ["balance:min"] }]);
    expect(
      await issues(e.updateMany({ where: { age: 20 }, data: { balance: { decrement: 5n } } })),
    ).toEqual(["data.balance min"]);
    expect(calls[0]!.text).toBe(
      "MATCH (n:`VrUser`) WHERE n.`age` = $p0 WITH collect(n) AS ns" +
        ' WITH ns, [b IN [n IN ns | [x IN [CASE WHEN (n.`balance` - $p1) < $p2 THEN "balance:min" END] WHERE x IS NOT NULL]] WHERE size(b) > 0] AS bad' +
        " FOREACH (n IN CASE WHEN size(bad) = 0 THEN ns ELSE [] END | SET n.`balance` = n.`balance` - $p1)" +
        " RETURN size(ns) AS c, bad[0] AS bad",
    );
  });

  it("guards upsert's update of an existing node", async () => {
    const { calls, e } = engine("VrUser", () => [
      { id: "4:u", created: false, bad: ["age:max"], row: {} },
    ]);
    expect(
      await issues(
        e.upsert({
          where: { email: "ada@example.com" },
          create: valid,
          update: { age: { increment: 1 } },
        }),
      ),
    ).toEqual(["update.age max"]);
    expect(calls[0]!.text).toContain(
      "WITH n, created, CASE WHEN created THEN [] ELSE [x IN [CASE WHEN (n.`age` + $p",
    );
    expect(calls[0]!.text).toContain(
      "FOREACH (x IN CASE WHEN created OR size(bad) > 0 THEN [] ELSE [1] END | SET n.`age` = n.`age` + $p",
    );
    expect(calls[0]!.text).toContain("RETURN elementId(n) AS id, created, bad,");
  });
});
