import { describe, expect, it } from "vitest";
import { schemaModel } from "./__fixtures__/interfaces.gen.js";
import { ModelEngine, type Executor, type Runner } from "./engine.js";
import { CyphraValidationError } from "./errors.js";
import { hasDeleteRules } from "./onDelete.js";
import { decodePath } from "./path.js";

type Call = { text: string; params: Record<string, unknown> };

function engine(
  name: string,
  answer: (text: string, params: Record<string, unknown>) => Record<string, unknown>[] = () => [],
) {
  const calls: Call[] = [];
  const exec: Executor = async (text, params) => {
    calls.push({ text, params });
    return answer(text, params);
  };
  const runner: Runner = { read: (fn) => fn(exec), write: (fn) => fn(exec) };
  const node = schemaModel.nodes.find((n) => n.name === name)!;
  return { calls, e: new ModelEngine(schemaModel, node, runner) };
}

const node = (name: string) => schemaModel.nodes.find((n) => n.name === name)!;

describe("interfaces: labels", () => {
  it("writes and matches every label of an implementation", async () => {
    const { calls, e } = engine("Employee", (text) =>
      text.startsWith("CREATE") ? [{ id: "e1" }] : [{ row: { id: "x" } }],
    );
    await e.create({ data: { email: "a@x", name: "A" } });
    expect(calls[0]!.text).toBe(
      "CREATE (n:`Employee`:`Person`:`Archivable` $p0) RETURN elementId(n) AS id",
    );
    expect(calls[1]!.text).toMatch(/^MATCH \(n:`Employee`:`Person`:`Archivable`\) WHERE/);
    await e.count({ where: { salary: { gt: 1 } } });
    expect(calls[2]!.text).toBe(
      "MATCH (n:`Employee`:`Person`:`Archivable`) WHERE n.`salary` > $p0 RETURN count(n) AS c",
    );
  });

  it("matches an interface by its own label", async () => {
    const { calls, e } = engine("Person", () => [{ c: 2 }]);
    await e.count();
    expect(calls[0]!.text).toBe("MATCH (n:`Person`) RETURN count(n) AS c");
  });

  it("matches relation targets with all their labels", async () => {
    const { calls, e } = engine("Team", () => []);
    await e.findMany({ include: { members: true, owner: true } });
    expect(calls[0]!.text).toContain("(n)<-[r1:`MEMBER_OF`]-(m0:`Employee`:`Person`:`Archivable`)");
    expect(calls[0]!.text).toContain("(n)<-[r3:`OWNS`]-(m2:`Person`)");
  });
});

describe("interfaces: reads", () => {
  it("projects every implementation's fields and the labels, and decodes a union", async () => {
    const { calls, e } = engine("Person", () => [
      {
        row: {
          id: "1",
          email: "e@x",
          name: "E",
          bio: null,
          salary: 10,
          tier: null,
          level: null,
          __labels: ["Employee", "Person", "Archivable"],
        },
      },
      {
        row: {
          id: "2",
          email: "c@x",
          name: "C",
          bio: "hi",
          salary: null,
          tier: "gold",
          level: 3,
          __labels: ["Customer", "Person"],
        },
      },
      { row: { id: "3", email: "p@x", name: "P", bio: null, __labels: ["Person"] } },
    ]);
    const rows = await e.findMany();
    expect(calls[0]!.text).toBe(
      "MATCH (n:`Person`) RETURN n{.`id`, .`email`, .`name`, .`bio`, .`salary`, .`tier`, .`level`, `__labels`: labels(n)} AS row",
    );
    expect(rows).toEqual([
      { __typename: "Employee", id: "1", email: "e@x", name: "E", bio: null, salary: 10 },
      {
        __typename: "Customer",
        id: "2",
        email: "c@x",
        name: "C",
        bio: "hi",
        tier: "gold",
        level: 3,
      },
      // No implementation label (written outside Cyphra): the interface and its fields.
      { __typename: "Person", id: "3", email: "p@x", name: "P", bio: null },
    ]);
  });

  it("selects interface fields only, still reporting __typename", async () => {
    const { calls, e } = engine("Person", () => [
      { row: { name: "C", __labels: ["Person", "Customer"] } },
    ]);
    expect(await e.findMany({ select: { name: true } })).toEqual([
      { __typename: "Customer", name: "C" },
    ]);
    expect(calls[0]!.text).toBe(
      "MATCH (n:`Person`) RETURN n{.`name`, `__labels`: labels(n)} AS row",
    );
    await expect(e.findMany({ select: { salary: true } })).rejects.toThrow(
      /Unknown field "Person.salary"/,
    );
  });

  it("decodes included interface targets as unions", async () => {
    const { calls, e } = engine("Employee", () => [
      {
        row: {
          id: "1",
          email: "e@x",
          name: "E",
          bio: null,
          salary: 1,
          manager: {
            id: "2",
            email: "b@x",
            name: "B",
            bio: null,
            tier: "x",
            level: null,
            __labels: ["Customer", "Person"],
          },
        },
      },
    ]);
    const [row] = await e.findMany({ include: { manager: true } });
    expect(calls[0]!.text).toContain("`__labels`: labels(m0)");
    expect(row!.manager).toEqual({
      __typename: "Customer",
      id: "2",
      email: "b@x",
      name: "B",
      bio: null,
      tier: "x",
      level: null,
    });
  });

  it("filters inherited full-text indexes to the implementation's nodes", async () => {
    const { calls, e } = engine("Employee", () => []);
    await e.search({ index: "personSearch", query: "ann" });
    expect(calls[0]!.text).toContain(
      "WITH node AS n, score WHERE (n:`Employee`:`Person`:`Archivable`) WITH n",
    );
    const p = engine("Person", () => []);
    await p.e.search({ index: "personSearch", query: "ann", where: { name: "x" } });
    expect(p.calls[0]!.text).toContain("WITH node AS n, score WHERE (n.`name` = $p0) WITH n");
  });

  it("decodes path nodes as their implementation", () => {
    const path = decodePath(schemaModel, {
      nodes: [
        {
          labels: ["Person", "Customer"],
          properties: { id: "1", email: "c@x", name: "C", tier: "t", extra: 1 },
        },
      ],
      edges: [],
    });
    expect(path.nodes[0]).toEqual({
      id: "1",
      email: "c@x",
      name: "C",
      bio: null,
      tier: "t",
      level: null,
    });
  });
});

describe("interfaces: writes", () => {
  it.each(["create", "createMany", "upsert"] as const)("rejects %s on an interface", async (op) => {
    const { calls, e } = engine("Person");
    const args =
      op === "create"
        ? { data: { email: "a@x", name: "A" } }
        : op === "createMany"
          ? { data: [{ email: "a@x", name: "A" }] }
          : { where: { email: "a@x" }, create: { email: "a@x", name: "A" }, update: {} };
    await expect((e[op] as (a: unknown) => Promise<unknown>)(args)).rejects.toThrow(
      new CyphraValidationError(
        `Person.${op}: Person is an interface and cannot be created; create one of its implementations (Employee, Customer) instead.`,
      ),
    );
    expect(calls).toEqual([]);
  });

  it("rejects a nested create into an interface target, connects to one", async () => {
    const { calls, e } = engine("Employee", (text) =>
      text.startsWith("CREATE")
        ? [{ id: "e1" }]
        : text.includes("MERGE")
          ? [{ c: 1 }]
          : [{ row: {} }],
    );
    await expect(
      e.create({
        data: { email: "a@x", name: "A", manager: { create: { email: "b@x", name: "B" } } },
      }),
    ).rejects.toThrow(/Person is an interface and cannot be created/);
    calls.length = 0;
    await e.create({ data: { email: "a@x", name: "A", manager: { connect: { email: "b@x" } } } });
    const connect = calls.find((c) => c.text.includes("MERGE"))!.text;
    expect(connect).toContain("MATCH (b:`Person`) WHERE b.`email` = $p0");
    // The inverse (`reports`) is to-many, so only `a`'s previous manager edge is replaced.
    expect(connect).toContain("(a)<-[old:`MANAGES`]-(other:`Person`)");
  });

  it("updates through an interface", async () => {
    const { calls, e } = engine("Person", (text) =>
      text.includes("RETURN elementId(n) AS id")
        ? [{ id: "p1" }]
        : [{ row: { __labels: ["Employee"] } }],
    );
    await e.update({ where: { email: "a@x" }, data: { name: "B" } });
    expect(calls[0]!.text).toBe(
      "MATCH (n:`Person`) WHERE n.`email` = $p0 RETURN elementId(n) AS id LIMIT 1",
    );
    expect(calls[1]!.text).toBe("MATCH (n) WHERE elementId(n) = $p1 SET n.`name` = $p0");
  });
});

describe("interfaces: onDelete", () => {
  it("sees the rules of every implementation", () => {
    expect(hasDeleteRules(schemaModel, node("Person"))).toBe(true);
    expect(hasDeleteRules(schemaModel, node("Customer"))).toBe(true); // inherited notes Cascade
    expect(hasDeleteRules(schemaModel, node("Archivable"))).toBe(true); // via Employee
    expect(hasDeleteRules(schemaModel, node("Badge"))).toBe(false);
  });

  it("applies the implementation's rules when deleting through the interface", async () => {
    const { calls, e } = engine("Person", (text) => {
      if (text.startsWith("MATCH (n:`Person`)")) return [{ id: "e1" }];
      if (text.includes("labels(n) AS labels"))
        return [{ id: "e1", labels: ["Person", "Employee"] }];
      if (text.includes("HAS_BADGE")) return [{ id: "b1" }];
      if (text.includes("WROTE")) return [{ id: "n1" }];
      if (text.includes("DETACH DELETE")) return [{ c: 1 }];
      return [];
    });
    expect(await e.deleteMany({ where: { name: "E" } })).toEqual({ count: 1 });
    const texts = calls.map((c) => c.text);
    expect(texts.some((t) => t.includes("[:`WROTE`]->(b:`Note`)"))).toBe(true);
    expect(texts.some((t) => t.includes("[:`HAS_BADGE`]->(b:`Badge`)"))).toBe(true);
    const del = calls.find((c) => c.text.includes("DETACH DELETE"))!;
    expect(new Set(del.params.p1 as string[])).toEqual(new Set(["e1", "b1", "n1"]));
  });
});

describe("interfaces: vector search", () => {
  it("filters an inherited vector index to the implementation's nodes", async () => {
    const { parseSchema, resolveSchema } = await import("@cyphra/schema");
    const model = resolveSchema(
      parseSchema(`
        interface Doc { id String @id
          embedding Vector(2)? @vectorIndex }
        node Page implements Doc { title String }
      `),
    );
    const calls: string[] = [];
    const exec: Executor = async (text) => {
      calls.push(text);
      return [];
    };
    const runner: Runner = { read: (fn) => fn(exec), write: (fn) => fn(exec) };
    const page = new ModelEngine(model, model.nodes[1]!, runner);
    await page.findSimilar({ field: "embedding", vector: [1, 0], k: 2 });
    expect(calls[0]).toContain("CALL db.index.vector.queryNodes($p2, $cyphraCandidates, $p0)");
    expect(calls[0]).toContain("WHERE n:`Page`:`Doc`");
    const doc = new ModelEngine(model, model.nodes[0]!, runner);
    await doc.findSimilar({ field: "embedding", vector: [1, 0], k: 2 });
    expect(calls[1]).not.toContain("WHERE n:");
  });
});
