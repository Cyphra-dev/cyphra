import { describe, expect, it } from "vitest";
import neo4j from "neo4j-driver";
import { createClient, schemaModel } from "./__fixtures__/blog.gen.js";
import type { DriverLike, TransactionLike } from "../client.js";
import { computedFieldsOf } from "./client.js";
import { CYPHER_NODE, cypherFragment as cypher, encodeCypherParam } from "./cypherExpr.js";
import { ModelEngine, type Executor, type Runner } from "./engine.js";
import { CyphraValidationError } from "./errors.js";
import type { EngineRules } from "./scope.js";
import { CypherInteger } from "../cypher-values.js";

type Call = { text: string; params: Record<string, unknown> };
type Row = Record<string, unknown>;

function engine(name: string, rules: EngineRules[] = [], answer: () => Row[] = () => []) {
  const calls: Call[] = [];
  const exec: Executor = async (text, params) => {
    calls.push({ text, params });
    return answer();
  };
  const runner: Runner = { read: (fn) => fn(exec), write: (fn) => fn(exec) };
  const model = schemaModel.nodes.find((n) => n.name === name)!;
  return { calls, e: new ModelEngine(schemaModel, model, runner, { rules }) };
}

const followers = cypher`COUNT { (${CYPHER_NODE})<-[:FOLLOWS]-() }`;

describe("Cypher expressions in select, where and orderBy (internal)", () => {
  it("projects a scalar expression with its node variable, and decodes it by its type", async () => {
    const { calls, e } = engine("User", [], () => [{ row: { id: "u1", followers: neo4j.int(3) } }]);
    const rows = await e.findMany({
      select: { id: true, followers: { $cypher: followers, $type: "Int" } },
    });
    expect(calls[0]!.text).toContain("`followers`: (COUNT { (n)<-[:FOLLOWS]-() })");
    expect(rows).toEqual([{ id: "u1", followers: 3 }]);
  });

  it("binds every interpolated value as a parameter, never as text", async () => {
    const evil = "x' }) DETACH DELETE n //";
    const { calls, e } = engine("User");
    await e.findMany({
      select: {
        id: true,
        same: { $cypher: cypher`${CYPHER_NODE}.name = ${evil}`, $type: "Boolean" },
      },
      where: {
        $cypher: [
          { expr: cypher`size(${CYPHER_NODE}.tags) + ${2n}`, type: "Int", filter: { gte: 1 } },
        ],
      },
    });
    const { text, params } = calls[0]!;
    expect(text).not.toContain("DETACH");
    expect(Object.values(params)).toContain(evil);
    expect(Object.values(params).some((p) => p instanceof CypherInteger)).toBe(true);
  });

  it("inlines nested fragments and filters and sorts on an expression", async () => {
    const { calls, e } = engine("User");
    const inner = cypher`${CYPHER_NODE}.age`;
    await e.findMany({
      where: {
        $cypher: [{ expr: cypher`coalesce(${inner}, 0)`, type: "Int", filter: { gt: 18 } }],
      },
      orderBy: [{ $cypher: { expr: followers, type: "Int", sort: "desc" } }, { id: "asc" }],
      select: { id: true },
    });
    const text = calls[0]!.text;
    expect(text).toMatch(/WHERE \(coalesce\(\(n\.age\), 0\)\) > \$p\d+/);
    expect(text).toContain("ORDER BY (COUNT { (n)<-[:FOLLOWS]-() }) DESC, n.`id` ASC");
  });

  it("projects the nodes an expression returns, with the target's read rules", async () => {
    const rules: EngineRules = { Post: { read: { published: true } } };
    const { calls, e } = engine("User", [rules], () => [
      { row: { id: "u1", top: [{ id: "p1", views: neo4j.int(7) }], first: null } },
    ]);
    const rows = await e.findMany({
      select: {
        id: true,
        top: {
          $cypher: cypher`[(${CYPHER_NODE})-[:AUTHORED]->(p) | p]`,
          $model: "Post",
          $many: true,
          select: { id: true, views: true },
          orderBy: { views: "desc" },
          take: 2,
        },
        first: {
          $cypher: cypher`head([(${CYPHER_NODE})-[:AUTHORED]->(p) | p])`,
          $model: "Post",
          select: { id: true },
        },
      },
    });
    const text = calls[0]!.text;
    expect(text).toContain(
      "UNWIND ([(n)-[:AUTHORED]->(p) | p]) AS m0 WITH m0 WHERE (m0:`Post`) AND (m0.`published` = $p0)",
    );
    expect(text).toContain("m0.`published` = $");
    expect(text).toContain("LIMIT");
    expect(text).toMatch(/`first`: head\(COLLECT \{ UNWIND \[\(head/);
    expect(rows).toEqual([{ id: "u1", top: [{ id: "p1", views: 7 }], first: null }]);
  });

  it("rejects a key that is a scalar field or reserved, and a value that is not a fragment", async () => {
    const { e } = engine("User");
    await expect(
      e.findMany({ select: { name: { $cypher: followers, $type: "Int" } } }),
    ).rejects.toThrow(/cannot name a Cypher expression/);
    await expect(
      e.findMany({ select: { x: { $cypher: "MATCH (n) DETACH DELETE n", $type: "Int" } } }),
    ).rejects.toThrow(CyphraValidationError);
    await expect(
      e.findMany({ select: { x: { $cypher: followers, $type: "Nope" } } }),
    ).rejects.toThrow(/\$type must be a scalar type/);
  });

  it("encodes typed parameters like properties", () => {
    expect(encodeCypherParam("Int", 3)).toBeInstanceOf(CypherInteger);
    expect(encodeCypherParam("String", null)).toBeNull();
    expect(() => encodeCypherParam("Int", "3")).toThrow(CyphraValidationError);
  });
});

describe("computedFieldsOf", () => {
  const tx: TransactionLike = { run: async () => ({ records: [] }) };
  const driver = {
    session: () => ({
      executeRead: (fn: (t: TransactionLike) => unknown) => fn(tx),
      executeWrite: (fn: (t: TransactionLike) => unknown) => fn(tx),
      close: async () => {},
    }),
    close: async () => {},
  } as unknown as DriverLike;

  it("lists the computed fields of a model with their needs", () => {
    const db = createClient({ driver }).$extends({
      result: {
        user: { label: { needs: { name: true, email: true }, compute: (u) => u.name ?? u.email } },
      },
    });
    expect([...(computedFieldsOf(db, "User") ?? [])]).toEqual([
      ["label", { needs: ["name", "email"], compute: expect.any(Function) }],
    ]);
    expect(computedFieldsOf(db, "Post")?.size).toBe(0);
    expect(computedFieldsOf({}, "User")).toBeUndefined();
  });
});
