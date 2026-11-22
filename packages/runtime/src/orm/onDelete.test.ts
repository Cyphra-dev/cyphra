import { describe, expect, it } from "vitest";
import { schemaModel } from "./__fixtures__/ondelete.gen.js";
import { schemaModel as blogModel } from "./__fixtures__/blog.gen.js";
import { ModelEngine, type Executor, type Runner } from "./engine.js";
import { RestrictError } from "./errors.js";
import { hasDeleteRules } from "./onDelete.js";

type Call = { text: string; params: Record<string, unknown> };

function engine(
  name: string,
  answer: (text: string, params: Record<string, unknown>) => Record<string, unknown>[],
  model = schemaModel,
) {
  const calls: Call[] = [];
  const exec: Executor = async (text, params) => {
    calls.push({ text, params });
    return answer(text, params);
  };
  const runner: Runner = { read: (fn) => fn(exec), write: (fn) => fn(exec) };
  const node = model.nodes.find((n) => n.name === name)!;
  return { calls, e: new ModelEngine(model, node, runner) };
}

const node = (name: string) => schemaModel.nodes.find((n) => n.name === name)!;

describe("hasDeleteRules", () => {
  it("is true when the model or a model its cascades reach has rules", () => {
    expect(hasDeleteRules(schemaModel, node("OdUser"))).toBe(true);
    expect(hasDeleteRules(schemaModel, node("OdRing"))).toBe(true);
    expect(hasDeleteRules(schemaModel, node("OdPlain"))).toBe(false);
    expect(hasDeleteRules(schemaModel, node("OdSession"))).toBe(false);
    for (const n of blogModel.nodes) expect(hasDeleteRules(blogModel, n)).toBe(false);
  });
});

describe("deleteMany with onDelete rules", () => {
  it("keeps a single DETACH DELETE statement without rules", async () => {
    const { calls, e } = engine("OdPlain", () => [{ c: 3 }]);
    expect(await e.deleteMany()).toEqual({ count: 3 });
    expect(calls.map((c) => c.text)).toEqual([
      "MATCH (n:`OdPlain`) DETACH DELETE n RETURN count(*) AS c",
    ]);
  });

  it("with a cycle: locks, one statement per cascade level (cycle-safe), then checks and deletes", async () => {
    // a → b → a: the second level finds `a` again and stops.
    const next: Record<string, string> = { a: "b", b: "a" };
    const { calls, e } = engine("OdRing", (text, params) => {
      if (text.startsWith("MATCH (n:`OdRing`)")) return [{ id: "a", labels: ["OdRing"] }];
      if (text.includes("DETACH DELETE")) return [{ c: 1 }];
      const ids = params.p0 as string[];
      return [{ k0: ids.map((id) => ({ id: next[id], labels: ["OdRing"] })) }];
    });
    expect(await e.deleteMany({ where: { name: "a" } })).toEqual({ count: 1 });
    const texts = calls.map((c) => c.text);
    expect(texts).toHaveLength(4);
    expect(texts[0]).toBe(
      "MATCH (n:`OdRing`) WHERE n.`name` = $p0 SET n.`__cyphraLock` = true REMOVE n.`__cyphraLock`" +
        " WITH n AS y0 MATCH (n) WHERE elementId(n) = elementId(y0) WITH n" +
        " RETURN elementId(n) AS id, labels(n) AS labels",
    );
    expect(texts[1]).toBe(
      "CALL { MATCH (a)-[:`OD_NEXT`]->(b:`OdRing`) WHERE elementId(a) IN $p0 WITH DISTINCT b" +
        " SET b.`__cyphraLock` = true REMOVE b.`__cyphraLock`" +
        " RETURN collect({id: elementId(b), labels: labels(b)}) AS k0 } RETURN k0",
    );
    expect(texts[2]).toBe(texts[1]);
    const last = calls.at(-1)!;
    expect(last.text).toBe(
      "CALL { MATCH (n) WHERE elementId(n) IN $p0 WITH n, elementId(n) IN $p1 AS isRoot" +
        " DETACH DELETE n RETURN count(CASE WHEN isRoot THEN 1 END) AS c } RETURN c",
    );
    expect(new Set(last.params.p0 as string[])).toEqual(new Set(["a", "b"]));
  });

  it("throws RestrictError, the delete in the same statement being skipped", async () => {
    let checks = "";
    const { calls, e } = engine("OdUser", (text) => {
      if (text.startsWith("MATCH (n:`OdUser`)")) return [{ id: "u", labels: ["OdUser"] }];
      if (!text.includes("DETACH DELETE")) return [{}];
      // A count per Restrict field; only invoices has related nodes.
      const columns = [...text.matchAll(/\[:`(\w+)`\][^}]*? AS (rc\d+) }/g)];
      checks = columns.map((m) => `${m[1]}=${m[2]}`).join(",");
      return [Object.fromEntries(columns.map((m) => [m[2], m[1] === "OD_BILLED" ? 2 : 0]))];
    });
    const err = await e.deleteMany().catch((x: unknown) => x);
    expect(err).toBeInstanceOf(RestrictError);
    expect(err).toMatchObject({
      model: "OdUser",
      relation: "invoices",
      target: "OdInvoice",
      count: 2,
    });
    const last = calls.at(-1)!.text;
    // Restrict counts only nodes the operation does not delete itself, and the delete runs only
    // when every count is 0.
    expect(last).toContain("AND NOT elementId(b) IN $p0 RETURN count(DISTINCT b) AS");
    expect(checks).toBe("OD_BILLED=rc0,OD_MANAGES=rc1");
    expect(last).toContain("MATCH (n) WHERE rc0 = 0 AND rc1 = 0 AND elementId(n) IN $p0");
  });
});

describe("onDelete rules: acyclic cascades", () => {
  it("compile the whole delete into one statement", async () => {
    const { calls, e } = engine("OdFolder", () => [{ c: 1, rc5: 0, row: { id: "f", name: "x" } }]);
    expect(await e.delete({ where: { name: "x" } })).toEqual({ id: "f", name: "x" });
    expect(calls.map((c) => c.text)).toEqual([
      "MATCH (n:`OdFolder`) WHERE n.`name` = $p0 WITH n LIMIT 1" +
        " SET n.`__cyphraLock` = true REMOVE n.`__cyphraLock`" +
        " WITH n AS y3 MATCH (n) WHERE elementId(n) = elementId(y3) WITH n WITH n, [n] AS l0" +
        " WITH n, l0 CALL { WITH l0 UNWIND l0 AS a4 MATCH (a4)-[:`OD_CONTAINS`]->(b5:`OdFile`)" +
        " WITH DISTINCT b5 SET b5.`__cyphraLock` = true REMOVE b5.`__cyphraLock` RETURN collect(b5) AS l1 }" +
        " WITH n, l0, l1 CALL { WITH l1 UNWIND l1 AS a6 MATCH (a6)<-[:`OD_VERSION_OF`]-(b7:`OdVersion`)" +
        " WITH DISTINCT b7 SET b7.`__cyphraLock` = true REMOVE b7.`__cyphraLock` RETURN collect(b7) AS l2 }" +
        " WITH n, l0, l1, l2, l0 + l1 + l2 AS all8" +
        " WITH n, l0, l1, l2, all8 CALL { WITH all8, l1 UNWIND l1 AS a9" +
        " MATCH (a9)<-[:`OD_HOLDS`]-(b10:`OdHold`) WHERE NOT b10 IN all8 RETURN count(DISTINCT b10) AS rc11 }" +
        " WITH all8, l0, rc11, n{.`id`, .`name`} AS row" +
        " CALL { WITH all8, rc11 WITH all8 WHERE rc11 = 0 UNWIND all8 AS d12 WITH DISTINCT d12" +
        " MATCH (x13) WHERE elementId(x13) = elementId(d12) DETACH DELETE x13 RETURN count(*) AS deleted14 }" +
        " RETURN CASE WHEN rc11 = 0 THEN size(l0) ELSE 0 END AS c, rc11, row",
    ]);
  });

  it("deleteMany: the roots are collected; a broken Restrict deletes nothing", async () => {
    const { calls, e } = engine("OdFile", (text) => [
      { c: 0, ...Object.fromEntries([...text.matchAll(/ AS (rc\d+)/g)].map((m) => [m[1], 1])) },
    ]);
    const err = await e.deleteMany().catch((x: unknown) => x);
    expect(err).toMatchObject({ model: "OdFile", relation: "holds", target: "OdHold", count: 1 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.text).toContain("WITH n WITH collect(n) AS l0");
  });
});
