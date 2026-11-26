import { describe, expect, it } from "vitest";
import neo4j from "neo4j-driver";
import { schemaModel } from "./__fixtures__/blog.gen.js";
import { schemaModel as graphSchema } from "./__fixtures__/graph.gen.js";
import { ModelEngine, type Executor, type Runner } from "./engine.js";
import { CyphraValidationError } from "./errors.js";

type Call = { text: string; params: Record<string, unknown> };

/** A runner that records every statement and answers with canned rows. */
function fakeRunner(answer: (text: string) => Record<string, unknown>[]) {
  const calls: Call[] = [];
  const exec: Executor = async (text, params) => {
    calls.push({ text, params });
    return answer(text);
  };
  const runner: Runner = { read: (fn) => fn(exec), write: (fn) => fn(exec) };
  return { calls, runner };
}

function engine(name: string, answer: (text: string) => Record<string, unknown>[]) {
  const { calls, runner } = fakeRunner(answer);
  const model = schemaModel.nodes.find((n) => n.name === name)!;
  return { calls, e: new ModelEngine(schemaModel, model, runner) };
}

/** One row: `base`, plus 1 for every nested connect count (`count(r) AS c<n>`) of `text`. */
function withCounts(text: string, base: Record<string, unknown>): Record<string, unknown>[] {
  const counts = [...text.matchAll(/count\(\w+\) AS (c\d+)/g)].map((m) => [m[1]!, 1]);
  return [{ ...base, ...Object.fromEntries(counts) }];
}

const userRow = {
  id: "u1",
  email: "a@x.io",
  name: null,
  age: null,
  tags: [],
  createdAt: neo4j.types.DateTime.fromStandardDate(new Date("2024-01-01T00:00:00Z")),
};

describe("upsert", () => {
  it("compiles to a single MERGE with ON CREATE SET / ON MATCH SET", async () => {
    const { calls, e } = engine("User", () => [{ id: "4:x:0", row: userRow }]);
    const out = await e.upsert({
      where: { email: "a@x.io" },
      create: { email: "a@x.io", name: "A" },
      update: { age: { increment: 1 } },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.text).toBe(
      "MERGE (n:`User` {`email`: $p0}) ON CREATE SET n += $p1 ON MATCH SET n.`age` = n.`age` + $p2" +
        " RETURN elementId(n) AS id, n{.`id`, .`email`, .`name`, .`age`, .`tags`, .`createdAt`} AS row",
    );
    const created = calls[0]!.params.p1 as Record<string, unknown>;
    // Defaults are applied on create, but never to the MERGE key itself.
    expect(Object.keys(created).sort()).toEqual(["createdAt", "id", "name"]);
    expect(out.email).toBe("a@x.io");
  });

  it("does not generate a default for an @id used as the MERGE key", async () => {
    const { calls, e } = engine("User", () => [{ id: "4:x:0", row: userRow }]);
    await e.upsert({ where: { id: "u1" }, create: { email: "a@x.io" }, update: {} });
    expect(
      calls[0]!.text.startsWith("MERGE (n:`User` {`id`: $p0}) ON CREATE SET n += $p1 RETURN"),
    ).toBe(true);
    expect(calls[0]!.params.p0).toBe("u1");
    expect(calls[0]!.params.p1).not.toHaveProperty("id");
  });

  it("checks extra where filters before updating an existing node", async () => {
    const { calls, e } = engine("User", () => [{ id: "4:x:0", created: false, row: userRow }]);
    await e.upsert({
      where: { email: "a@x.io", name: "A" },
      create: { email: "a@x.io" },
      update: { name: "B" },
      select: { email: true },
    });
    expect(calls[0]!.text).toBe(
      "MERGE (n:`User` {`email`: $p0}) ON CREATE SET n += $p1, n.`__cyphraUpsertCreated` = true" +
        " WITH n, n.`__cyphraUpsertCreated` IS NOT NULL AS created REMOVE n.`__cyphraUpsertCreated`" +
        " WITH n, created WHERE created OR (n.`name` = $p2)" +
        " FOREACH (x IN CASE WHEN created THEN [] ELSE [1] END | SET n.`name` = $p3)" +
        " RETURN elementId(n) AS id, created, n{.`email`} AS row",
    );
  });

  it("runs the nested writes of the branch MERGE took, with the projection", async () => {
    const { calls, e } = engine("User", (text) =>
      text.startsWith("MERGE (n:")
        ? [{ id: "4:x:0", created: true }]
        : withCounts(text, { row: userRow }),
    );
    await e.upsert({
      where: { email: "a@x.io" },
      create: { email: "a@x.io", following: { connect: { id: "u2" } } },
      update: { followers: { connect: { id: "u3" } } },
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]!.text).toContain("RETURN elementId(n) AS id, created");
    expect(calls[0]!.text).not.toContain("AS row");
    // The create branch's relation (following = OUT), not the update one (followers = IN).
    expect(calls[1]!.text).toBe(
      "MATCH (n) WHERE elementId(n) = $p0 WITH n CALL { WITH n MATCH (b0:`User`) WHERE b0.`id` = $p1" +
        " WITH n, b0 LIMIT 1 MERGE (n)-[r1:`FOLLOWS`]->(b0) ON CREATE SET r1 += $p2 RETURN count(r1) AS c2 }" +
        " RETURN n{.`id`, .`email`, .`name`, .`age`, .`tags`, .`createdAt`} AS row, c2",
    );
    expect(calls[1]!.params.p0).toBe("4:x:0");
  });

  it("rejects a create key that differs from where", async () => {
    const { e } = engine("User", () => []);
    await expect(
      e.upsert({ where: { email: "a@x.io" }, create: { email: "b@x.io" }, update: {} }),
    ).rejects.toBeInstanceOf(CyphraValidationError);
  });
});

const USER_ROW = " RETURN n{.`id`, .`email`, .`name`, .`age`, .`tags`, .`createdAt`} AS row";

describe("connect", () => {
  it("MERGEs the edge in the update statement; on a typed edge, defaults only ON CREATE", async () => {
    const { calls, e } = engine("User", (text) => withCounts(text, { row: userRow }));
    await e.update({
      where: { id: "u1" },
      data: { following: { connect: [{ id: "u2" }, { id: "u3", $edge: { since: new Date(0) } }] } },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.text).toBe(
      "MATCH (n:`User`) WHERE n.`id` = $p0 WITH n LIMIT 1" +
        " WITH n CALL { WITH n MATCH (b0:`User`) WHERE b0.`id` = $p1 WITH n, b0 LIMIT 1" +
        " MERGE (n)-[r1:`FOLLOWS`]->(b0) ON CREATE SET r1 += $p2 RETURN count(r1) AS c2 }" +
        " WITH n, c2 CALL { WITH n MATCH (b3:`User`) WHERE b3.`id` = $p3 WITH n, b3 LIMIT 1" +
        " MERGE (n)-[r4:`FOLLOWS`]->(b3) ON CREATE SET r4 += $p4 ON MATCH SET r4 += $p5" +
        " RETURN count(r4) AS c5 }" +
        USER_ROW +
        ", c2, c5",
    );
    const { params } = calls[0]!;
    expect(Object.keys(params.p2 as object)).toEqual(["since"]);
    expect(params.p5).toEqual(params.p4);
  });

  it("throws NotFoundError when a connect target is missing", async () => {
    const { e } = engine("User", (text) => [{ ...withCounts(text, { row: userRow })[0], c2: 0 }]);
    await expect(
      e.update({ where: { id: "u1" }, data: { following: { connect: { id: "nobody" } } } }),
    ).rejects.toThrow('connect: no User matches {"id":"nobody"}.');
  });

  it("moves the target off its previous node when the inverse side is to-one", async () => {
    const { calls, e } = engine("User", (text) => withCounts(text, { row: userRow }));
    await e.update({ where: { id: "u1" }, data: { posts: { connect: { id: "p1" } } } });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.text).toBe(
      "MATCH (n:`User`) WHERE n.`id` = $p0 WITH n LIMIT 1" +
        " WITH n CALL { WITH n MATCH (b0:`Post`) WHERE b0.`id` = $p1 WITH n, b0 LIMIT 1" +
        " SET b0.`__cyphraLock` = true REMOVE b0.`__cyphraLock` WITH n, b0" +
        " OPTIONAL MATCH (x2:`User`)-[o3:`AUTHORED`]->(b0) WHERE x2 <> n" +
        " DELETE o3 WITH DISTINCT n, b0 MERGE (n)-[r1:`AUTHORED`]->(b0) RETURN count(r1) AS c4 }" +
        USER_ROW +
        ", c4",
    );
  });

  it("leaves many-to-many edges of the target alone", async () => {
    const { calls, e } = engine("User", (text) => withCounts(text, { row: userRow }));
    await e.update({ where: { id: "u1" }, data: { followers: { connect: { id: "u2" } } } });
    const text = calls[0]!.text;
    expect(text).not.toContain("DELETE");
    expect(text).toContain("MERGE (n)<-[r1:`FOLLOWS`]-(b0)");
  });

  it("to-one connect replaces the old edge in its own subquery, under a lock", async () => {
    const { calls, e } = engine("Post", (text) => withCounts(text, { row: {} }));
    await e.update({ where: { id: "p1" }, data: { author: { connect: { id: "u1" } } } });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.text).toBe(
      "MATCH (n:`Post`) WHERE n.`id` = $p0 WITH n LIMIT 1" +
        " WITH n CALL { WITH n MATCH (b0:`User`) WHERE b0.`id` = $p1 WITH n, b0 LIMIT 1" +
        " SET n.`__cyphraLock` = true REMOVE n.`__cyphraLock` WITH n, b0" +
        " OPTIONAL MATCH (n)<-[o3:`AUTHORED`]-(x2:`User`) WHERE x2 <> b0" +
        " DELETE o3 WITH DISTINCT n, b0 MERGE (n)<-[r1:`AUTHORED`]-(b0) RETURN count(r1) AS c4 }" +
        " RETURN n{.`id`, .`title`, .`published`, .`views`, .`score`, .`publishedOn`} AS row, c4",
    );
  });
});

describe("create", () => {
  it("creates nested children with one FOREACH per relation, in the create statement", async () => {
    const { calls, e } = engine("User", (text) => withCounts(text, { row: userRow }));
    await e.create({
      data: {
        email: "a@x.io",
        posts: { create: [{ title: "a" }, { title: "b" }] },
        following: { connect: { email: "b@x.io" } },
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.text).toBe(
      "CREATE (n:`User` $p0)" +
        " FOREACH (x0 IN $p1 | CREATE (c1:`Post`) SET c1 = x0.p CREATE (n)-[:`AUTHORED`]->(c1))" +
        " WITH n CALL { WITH n MATCH (b3:`User`) WHERE b3.`email` = $p2 WITH n, b3 LIMIT 1" +
        " MERGE (n)-[r4:`FOLLOWS`]->(b3) ON CREATE SET r4 += $p3 RETURN count(r4) AS c5 }" +
        USER_ROW +
        ", c5",
    );
    const rows = calls[0]!.params.p1 as { p: Record<string, unknown>; e: object }[];
    expect(rows.map((r) => r.p.title)).toEqual(["a", "b"]);
    expect(rows.every((r) => typeof r.p.id === "string" && r.p.published === false)).toBe(true);
  });

  it("gives a child with its own nested writes a CREATE of its own", async () => {
    const { calls, e } = engine("Post", (text) => withCounts(text, { row: {} }));
    await e.create({
      data: {
        title: "a",
        author: {
          create: {
            email: "c@x.io",
            following: { connect: { email: "d@x.io" } },
            posts: { create: { title: "s" } },
          },
        },
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.text).toBe(
      "CREATE (n:`Post` $p0) CREATE (c0:`User` $p1) CREATE (n)<-[:`AUTHORED`]-(c0)" +
        " WITH n, c0 CALL { WITH c0 MATCH (b1:`User`) WHERE b1.`email` = $p2 WITH c0, b1 LIMIT 1" +
        " MERGE (c0)-[r2:`FOLLOWS`]->(b1) ON CREATE SET r2 += $p3 RETURN count(r2) AS c3 }" +
        " FOREACH (x4 IN $p4 | CREATE (c5:`Post`) SET c5 = x4.p CREATE (c0)-[:`AUTHORED`]->(c5))" +
        " RETURN n{.`id`, .`title`, .`published`, .`views`, .`score`, .`publishedOn`} AS row, c3",
    );
  });

  it("validates every nested write before sending anything", async () => {
    const { calls, e } = engine("User", () => []);
    await expect(
      e.create({
        data: { email: "a@x.io", posts: { create: [{ title: "ok" }, { nope: 1 }] } },
      }),
    ).rejects.toBeInstanceOf(CyphraValidationError);
    expect(calls).toHaveLength(0);
  });
});

describe("delete", () => {
  it("locks, reads and deletes in one statement without onDelete rules", async () => {
    const { calls, e } = engine("User", () => [{ row: userRow }]);
    await e.delete({ where: { email: "a@x.io" } });
    expect(calls.map((c) => c.text)).toEqual([
      "MATCH (n:`User`) WHERE n.`email` = $p0 WITH n LIMIT 1" +
        " SET n.`__cyphraLock` = true REMOVE n.`__cyphraLock`" +
        " WITH n AS y0 MATCH (n) WHERE elementId(n) = elementId(y0) WITH n" +
        " WITH n, n{.`id`, .`email`, .`name`, .`age`, .`tags`, .`createdAt`} AS row" +
        " DETACH DELETE n RETURN row",
    ]);
  });
});

describe("$edge number updates", () => {
  function graphEngine(name: string, answer: (text: string) => Record<string, unknown>[]) {
    const { calls, runner } = fakeRunner(answer);
    const model = graphSchema.nodes.find((n) => n.name === name)!;
    return { calls, e: new ModelEngine(graphSchema, model, runner) };
  }
  const entityRow = { id: "e1", name: "Ada", kind: "person" };
  // Every connect found its target; each `$edge` guard (`… AS g<n>`) reports `bad`.
  const answer = (bad: string[]) => (text: string) => {
    const guards = [...text.matchAll(/ AS (g\d+)/g)].map((m) => [m[1]!, bad]);
    return withCounts(text, { row: entityRow, ...Object.fromEntries(guards) });
  };

  it("SETs the new value after the MERGE, checking @min / @max on the result", async () => {
    const { calls, e } = graphEngine("GrEntity", answer([]));
    await e.update({
      where: { id: "e1" },
      data: {
        related: {
          connect: {
            id: "e2",
            $edge: { weight: { increment: 1 }, score: { multiply: 2 }, note: "n" },
          },
        },
      },
    });
    expect(calls).toHaveLength(1);
    const c = calls[0]!;
    expect(c.text).toBe(
      "MATCH (n:`GrEntity`) WHERE n.`id` = $p0 WITH n LIMIT 1" +
        " WITH n CALL { WITH n MATCH (b0:`GrEntity`) WHERE b0.`id` = $p7 WITH n, b0 LIMIT 1" +
        " MERGE (n)-[r1:`GR_RELATED`]->(b0) ON CREATE SET r1 += $p8 ON MATCH SET r1 += $p9" +
        " SET r1.`weight` = (coalesce(r1.`weight`, $p1) + $p2), r1.`score` = (coalesce(r1.`score`, $p5) * $p6)" +
        " RETURN count(r1) AS c2, collect([x IN [" +
        'CASE WHEN r1.`weight` < $p3 THEN "weight:min" END, ' +
        'CASE WHEN r1.`weight` > $p4 THEN "weight:max" END] WHERE x IS NOT NULL])[0] AS g3 }' +
        " RETURN n{.`id`, .`name`, .`kind`} AS row, c2, g3",
    );
    // A new edge: defaults, then the operators (score has no default: it starts from 0).
    const created = c.params.p8 as Record<string, unknown>;
    expect([String(created.weight), created.score, created.note]).toEqual(["0", 0, "n"]);
    expect(c.params.p9).toEqual({ note: "n" });
  });

  it("throws (rolling the write back) when the result breaks @min / @max", async () => {
    const { e } = graphEngine("GrEntity", answer(["weight:max"]));
    const err = await e
      .update({
        where: { id: "e1" },
        data: { related: { connect: [{ id: "e2", $edge: { weight: { increment: 9 } } }] } },
      })
      .catch((x: unknown) => x);
    expect(err).toBeInstanceOf(CyphraValidationError);
    expect((err as CyphraValidationError).issues).toEqual([
      expect.objectContaining({
        path: ["data", "related", "connect", 0, "$edge", "weight"],
        model: "GrRelated",
        field: "weight",
        rule: "max",
      }),
    ]);
  });

  it("set keeps the edges to listed nodes, so updates apply to them", async () => {
    const { calls, e } = graphEngine("GrEntity", answer([]));
    await e.update({
      where: { id: "e1" },
      data: { related: { set: [{ id: "e2", $edge: { weight: { decrement: 1 } } }] } },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.text).toBe(
      "MATCH (n:`GrEntity`) WHERE n.`id` = $p0 WITH n LIMIT 1" +
        " WITH n CALL { WITH n MATCH (n)-[r1:`GR_RELATED`]->(b0:`GrEntity`) WHERE NOT ((b0.`id` = $p1))" +
        " DELETE r1 RETURN count(*) AS d2 }" +
        " WITH n, d2 CALL { WITH n MATCH (b3:`GrEntity`) WHERE b3.`id` = $p6 WITH n, b3 LIMIT 1" +
        " MERGE (n)-[r4:`GR_RELATED`]->(b3) ON CREATE SET r4 += $p7" +
        " SET r4.`weight` = (coalesce(r4.`weight`, $p2) - $p3)" +
        " RETURN count(r4) AS c5, collect([x IN [" +
        'CASE WHEN r4.`weight` < $p4 THEN "weight:min" END, ' +
        'CASE WHEN r4.`weight` > $p5 THEN "weight:max" END] WHERE x IS NOT NULL])[0] AS g6 }' +
        " RETURN n{.`id`, .`name`, .`kind`} AS row, c5, g6",
    );
  });

  it("rejects number updates on create and unknown operators", async () => {
    const { e } = graphEngine("GrEntity", answer([]));
    await expect(
      e.update({
        where: { id: "e1" },
        data: {
          related: { create: { id: "e3", name: "x", $edge: { weight: { increment: 1 } } } },
        },
      }),
    ).rejects.toThrow("$edge number updates ({ increment, … }) are for connect and set");
    await expect(
      e.update({
        where: { id: "e1" },
        data: { related: { connect: { id: "e2", $edge: { weight: { divide: 2 } } } } },
      }),
    ).rejects.toThrow('GrEntity.related.$edge.weight: unknown number update "divide"');
  });
});

describe("nested update / delete / upsert / connectOrCreate", () => {
  it("compiles every nested write into the one statement of the update", async () => {
    // Every count of the statement is 1: each target was found.
    const { calls, e } = engine("User", (text) => [
      {
        row: userRow,
        ...Object.fromEntries(
          [...text.matchAll(/count\([\w*]+\) AS (\w+)/g)].map((m) => [m[1]!, 1]),
        ),
      },
    ]);
    await e.update({
      where: { id: "u1" },
      data: {
        posts: {
          update: { where: { id: "p1" }, data: { title: "T" } },
          delete: { id: "p2" },
          upsert: { where: { id: "p3" }, create: { title: "N" }, update: { views: 1 } },
        },
      },
    });
    expect(calls).toHaveLength(1);
    const text = calls[0]!.text;
    // The delete, then the update, then the upsert's update and its create (only when nothing
    // was updated), each a subquery from the user.
    expect(text).toContain(
      "CALL { WITH n MATCH (n)-[:`AUTHORED`]->(x0:`Post`) WHERE x0.`id` = $p1 WITH x0 LIMIT 1 DETACH DELETE x0 RETURN count(*) AS d1 }",
    );
    expect(text).toContain(
      "CALL { WITH n MATCH (n)-[:`AUTHORED`]->(u2:`Post`) WHERE u2.`id` = $p2 WITH u2 LIMIT 1 SET u2.`title` = $p3 RETURN count(u2) AS f3 }",
    );
    expect(text).toMatch(
      /CALL \{ WITH n, f5 WITH n WHERE f5 = 0 FOREACH .* RETURN count\(\*\) AS k\d+ \}/,
    );
  });

  it("throws NotFoundError when a nested update target is not linked", async () => {
    const { e } = engine("User", (text) => {
      const f = /count\(u\d+\) AS (f\d+)/.exec(text)![1]!;
      return [{ row: userRow, [f]: 0 }];
    });
    await expect(
      e.update({
        where: { id: "u1" },
        data: { posts: { update: { where: { id: "p9" }, data: {} } } },
      }),
    ).rejects.toThrow(/User\.posts\.update: no Post linked to this User matches \{"id":"p9"\}/);
  });

  it("refuses nested update / delete / upsert on a create, and unknown shapes", async () => {
    const { e } = engine("User", () => []);
    await expect(
      e.create({ data: { email: "a", posts: { delete: { id: "p" } } } }),
    ).rejects.toThrow(/unsupported relation operation "delete" \(only on update\)/);
    await expect(
      e.update({ where: { id: "u1" }, data: { posts: { delete: true } } }),
    ).rejects.toThrow(CyphraValidationError);
    const post = engine("Post", () => []);
    await expect(
      post.e.update({ where: { id: "p" }, data: { author: { delete: true, update: {} } } }),
    ).rejects.toThrow(/use only one of update \/ delete/);
  });
});
