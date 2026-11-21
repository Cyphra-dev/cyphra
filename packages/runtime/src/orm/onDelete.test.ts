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

  it("locks, follows cascades level by level (cycle-safe), checks restrict, then deletes once", async () => {
    // a → b → a: the second level finds `a` again and stops.
    const next: Record<string, string> = { a: "b", b: "a" };
    const { calls, e } = engine("OdRing", (text, params) => {
      if (text.startsWith("MATCH (n:`OdRing`)")) return [{ id: "a" }];
      if (text.includes("OD_NEXT")) {
        return (params.p0 as string[]).map((id) => ({ id: next[id] }));
      }
      if (text.includes("DETACH DELETE")) return [{ c: 1 }];
      return [];
    });
    expect(await e.deleteMany({ where: { name: "a" } })).toEqual({ count: 1 });
    const texts = calls.map((c) => c.text);
    expect(texts[0]).toBe(
      "MATCH (n:`OdRing`) WHERE n.`name` = $p0 SET n.`__cyphraLock` = true REMOVE n.`__cyphraLock` RETURN elementId(n) AS id",
    );
    expect(texts.filter((t) => t.includes("OD_NEXT"))).toHaveLength(2);
    expect(texts[1]).toBe(
      "MATCH (a)-[:`OD_NEXT`]->(b:`OdRing`) WHERE elementId(a) IN $p0 WITH DISTINCT b SET b.`__cyphraLock` = true REMOVE b.`__cyphraLock` RETURN elementId(b) AS id",
    );
    const last = calls.at(-1)!;
    expect(last.text).toContain("DETACH DELETE n");
    expect(new Set(last.params.p1 as string[])).toEqual(new Set(["a", "b"]));
  });

  it("throws RestrictError before any delete", async () => {
    const { calls, e } = engine("OdUser", (text) => {
      if (text.startsWith("MATCH (n:`OdUser`)")) return [{ id: "u" }];
      if (text.includes("OD_BILLED")) return [{ c: 2 }];
      return [];
    });
    const err = await e.deleteMany().catch((x: unknown) => x);
    expect(err).toBeInstanceOf(RestrictError);
    expect(err).toMatchObject({
      model: "OdUser",
      relation: "invoices",
      target: "OdInvoice",
      count: 2,
    });
    expect(calls.some((c) => c.text.includes("DETACH DELETE"))).toBe(false);
    // Restrict counts only nodes the operation does not delete itself.
    const restrict = calls.find((c) => c.text.includes("OD_BILLED"))!;
    expect(restrict.text).toContain("AND NOT elementId(b) IN $p1 RETURN count(DISTINCT b) AS c");
  });
});
