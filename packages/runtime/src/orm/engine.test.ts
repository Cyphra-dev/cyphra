import { describe, expect, it } from "vitest";
import neo4j from "neo4j-driver";
import { schemaModel } from "./__fixtures__/blog.gen.js";
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

  it("runs nested writes of the branch MERGE took, then reads back", async () => {
    const { calls, e } = engine("User", (text) => {
      if (text.startsWith("MERGE (n:")) return [{ id: "4:x:0", created: true }];
      if (text.includes("MERGE (a)")) return [{ c: 1 }];
      return [{ row: userRow }];
    });
    await e.upsert({
      where: { email: "a@x.io" },
      create: { email: "a@x.io", following: { connect: { id: "u2" } } },
      update: { followers: { connect: { id: "u3" } } },
    });
    expect(calls.map((c) => c.text.split(" ")[0])).toEqual(["MERGE", "MATCH", "MATCH"]);
    expect(calls[0]!.text).toContain("RETURN elementId(n) AS id, created");
    expect(calls[0]!.text).not.toContain("AS row");
    // The create branch's relation (following = OUT), not the update one (followers = IN).
    expect(calls[1]!.text).toContain("MERGE (a)-[r:`FOLLOWS`]->(b)");
  });

  it("rejects a create key that differs from where", async () => {
    const { e } = engine("User", () => []);
    await expect(
      e.upsert({ where: { email: "a@x.io" }, create: { email: "b@x.io" }, update: {} }),
    ).rejects.toBeInstanceOf(CyphraValidationError);
  });
});

describe("connect", () => {
  it("MERGEs the edge; on a typed edge, defaults only ON CREATE", async () => {
    const { calls, e } = engine("User", (text) =>
      text.includes("MERGE (a)") ? [{ c: 1 }] : [{ id: "4:x:0", row: userRow }],
    );
    await e.update({
      where: { id: "u1" },
      data: { following: { connect: [{ id: "u2" }, { id: "u3", $edge: { since: new Date(0) } }] } },
    });
    const connects = calls.filter((c) => c.text.includes("MERGE (a)"));
    expect(connects[0]!.text).toBe(
      "MATCH (a) WHERE elementId(a) = $p1 MATCH (b:`User`) WHERE b.`id` = $p0 WITH a, b LIMIT 1" +
        " MERGE (a)-[r:`FOLLOWS`]->(b) ON CREATE SET r += $p2 RETURN count(r) AS c",
    );
    expect(Object.keys(connects[0]!.params.p2 as object)).toEqual(["since"]);
    expect(connects[1]!.text).toContain(" ON CREATE SET r += $p2 ON MATCH SET r += $p3 RETURN");
    expect(connects[1]!.params.p3).toEqual(connects[1]!.params.p2);
  });

  it("MERGEs incoming edges with the right direction", async () => {
    const { calls, e } = engine("Post", (text) =>
      text.includes("MERGE (a)") ? [{ c: 1 }] : [{ id: "4:x:0", c: 1, row: {} }],
    );
    await e.update({ where: { id: "p1" }, data: { author: { connect: { id: "u1" } } } });
    expect(calls.some((c) => c.text.includes("DELETE r"))).toBe(true);
    expect(calls.find((c) => c.text.includes("MERGE (a)"))!.text).toContain(
      "MERGE (a)<-[r:`AUTHORED`]-(b) RETURN",
    );
  });
});
