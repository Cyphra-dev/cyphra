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
    const { calls, e } = engine("Employee", () => [{ row: { id: "x" } }]);
    await e.create({ data: { email: "a@x", name: "A" } });
    expect(calls[0]!.text).toBe(
      "CREATE (n:`Employee`:`Person`:`Archivable` $p0) RETURN n{.`id`, .`email`, .`name`, .`bio`, .`salary`} AS row",
    );
    await e.count({ where: { salary: { gt: 1 } } });
    expect(calls[1]!.text).toBe(
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
    // Every nested connect (`count(r) AS c<n>`) finds its target.
    const { calls, e } = engine("Employee", (text) => [
      {
        row: {},
        ...Object.fromEntries([...text.matchAll(/count\(\w+\) AS (c\d+)/g)].map((m) => [m[1], 1])),
      },
    ]);
    await expect(
      e.create({
        data: { email: "a@x", name: "A", manager: { create: { email: "b@x", name: "B" } } },
      }),
    ).rejects.toThrow(/Person is an interface and cannot be created/);
    calls.length = 0;
    await e.create({ data: { email: "a@x", name: "A", manager: { connect: { email: "b@x" } } } });
    expect(calls).toHaveLength(1);
    const connect = calls[0]!.text;
    expect(connect).toContain("MATCH (b0:`Person`) WHERE b0.`email` = $p1");
    // The inverse (`reports`) is to-many, so only `n`'s previous manager edge is replaced.
    expect(connect).toContain("(n)<-[o3:`MANAGES`]-(x2:`Person`)");
  });

  it("updates through an interface", async () => {
    const { calls, e } = engine("Person", () => [{ row: { __labels: ["Employee"] } }]);
    await e.update({ where: { email: "a@x" }, data: { name: "B" } });
    expect(calls.map((c) => c.text)).toEqual([
      "MATCH (n:`Person`) WHERE n.`email` = $p0 WITH n LIMIT 1 SET n.`name` = $p1" +
        " RETURN n{.`id`, .`email`, .`name`, .`bio`, .`salary`, .`tier`, .`level`, `__labels`: labels(n)} AS row",
    ]);
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
    // The roots come with their labels: no extra statement to tell which implementation each is.
    const reached: Record<string, { id: string; labels: string[] }[]> = {
      WROTE: [{ id: "n1", labels: ["Note"] }],
      HAS_BADGE: [{ id: "b1", labels: ["Badge"] }],
    };
    const { calls, e } = engine("Person", (text) => {
      if (text.startsWith("MATCH (n:`Person`)"))
        return [{ id: "e1", labels: ["Person", "Employee"] }];
      if (text.includes("DETACH DELETE")) return [{ c: 1 }];
      // One cascade level: a column of reached nodes per cascade field.
      const level = [...text.matchAll(/\[:`(\w+)`\].*? AS (k\d+) }/g)];
      return [Object.fromEntries(level.map((m) => [m[2], reached[m[1]!] ?? []]))];
    });
    expect(await e.deleteMany({ where: { name: "E" } })).toEqual({ count: 1 });
    const texts = calls.map((c) => c.text);
    // Lock the roots, one cascade level (notes and badges cascade no further), check and delete.
    expect(texts).toHaveLength(3);
    expect(texts[1]).toContain("[:`WROTE`]->(b:`Note`)");
    expect(texts[1]).toContain("[:`HAS_BADGE`]->(b:`Badge`)");
    const del = calls.find((c) => c.text.includes("DETACH DELETE"))!;
    expect(new Set(del.params.p0 as string[])).toEqual(new Set(["e1", "b1", "n1"]));
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

describe("interfaces: __typename filters and sorting", () => {
  it("filters an interface query by implementation label", async () => {
    const { calls, e } = engine("Person", () => [{ c: 1 }]);
    await e.count({ where: { __typename: "Employee" } });
    expect(calls[0]!.text).toBe("MATCH (n:`Person`) WHERE n:`Employee` RETURN count(n) AS c");
    await e.count({ where: { __typename: { in: ["Employee", "Customer"] }, name: "A" } });
    expect(calls[1]!.text).toBe(
      "MATCH (n:`Person`) WHERE ((n:`Employee`) OR (n:`Customer`)) AND (n.`name` = $p0) RETURN count(n) AS c",
    );
    await e.count({ where: { __typename: { notIn: ["Employee"] } } });
    expect(calls[2]!.text).toContain("WHERE NOT (n:`Employee`)");
    await e.count({ where: { __typename: { in: [] } } });
    expect(calls[3]!.text).toContain("WHERE false");
    await e.count({ where: { OR: [{ __typename: { not: "Customer" } }, { bio: null }] } });
    expect(calls[4]!.text).toContain("WHERE (NOT (n:`Customer`)) OR (n.`bio` IS NULL)");
  });

  it("filters relations whose target is an interface by implementation", async () => {
    const { calls, e } = engine("Team", () => []);
    await e.findMany({ where: { owner: { is: { __typename: "Customer" } } } });
    expect(calls[0]!.text).toContain(
      "EXISTS { MATCH (n)<-[:`OWNS`]-(m0:`Person`) WHERE m0:`Customer` }",
    );
  });

  it("rejects __typename on a node and unknown implementations", async () => {
    const { e } = engine("Person");
    await expect(e.findMany({ where: { __typename: "Team" } })).rejects.toThrow(
      /where.__typename on Person: expected "Employee" \| "Customer", got "Team"/,
    );
    await expect(e.findMany({ where: { __typename: { startsWith: "E" } } })).rejects.toThrow(
      /Unknown filter "startsWith" on Person.__typename/,
    );
    await expect(e.findMany({ where: { __typename: null } })).rejects.toThrow(/cannot be null/);
    const { e: emp } = engine("Employee");
    await expect(emp.findMany({ where: { __typename: "Employee" } })).rejects.toThrow(
      /Employee is not an interface/,
    );
    await expect(emp.findMany({ orderBy: { __typename: "asc" } })).rejects.toThrow(
      /Employee is not an interface/,
    );
  });

  it("sorts an interface query by implementation name", async () => {
    const { calls, params, e } = (() => {
      const r = engine("Person", () => []);
      return { ...r, params: () => r.calls[0]!.params };
    })();
    await e.findMany({ orderBy: [{ __typename: "desc" }, { email: "asc" }], select: { id: true } });
    expect(calls[0]!.text).toContain(
      "ORDER BY CASE WHEN n:`Employee` THEN $p0 WHEN n:`Customer` THEN $p1 ELSE $p2 END DESC, n.`email` ASC",
    );
    expect(params()).toMatchObject({ p0: "Employee", p1: "Customer", p2: "Person" });
  });
});

describe("interfaces: $on (per-implementation select / include)", () => {
  it("loads an implementation's own relations on its results only", async () => {
    const { calls, e } = engine("Person", () => [
      {
        row: {
          id: "1",
          email: "e@x",
          name: "E",
          bio: null,
          salary: 1,
          tier: null,
          level: null,
          __labels: ["Employee", "Person", "Archivable"],
          manager: null,
          __on_Employee: { team: { id: "t", name: "core" }, _count: { badges: 2 } },
          __on_Customer: null,
        },
      },
      {
        row: {
          id: "2",
          email: "c@x",
          name: "C",
          bio: null,
          salary: null,
          tier: "gold",
          level: 1,
          __labels: ["Customer", "Person"],
          manager: null,
          __on_Employee: null,
          __on_Customer: {},
        },
      },
    ]);
    const rows = await e.findMany({
      include: {
        manager: true,
        $on: { Employee: { team: true, _count: { select: { badges: true } } }, Customer: {} },
      },
    });
    expect(calls[0]!.text).toContain(
      "`__on_Employee`: CASE WHEN n:`Employee` THEN n{`team`: head(COLLECT { MATCH (n)-[r",
    );
    expect(calls[0]!.text).toContain("`_count`: {`badges`: COUNT { MATCH (n)-[:`HAS_BADGE`]->");
    expect(calls[0]!.text).toContain("`__on_Customer`: CASE WHEN n:`Customer` THEN n{} END");
    expect(rows).toEqual([
      {
        __typename: "Employee",
        id: "1",
        email: "e@x",
        name: "E",
        bio: null,
        salary: 1,
        manager: null,
        team: { id: "t", name: "core" },
        _count: { badges: 2 },
      },
      {
        __typename: "Customer",
        id: "2",
        email: "c@x",
        name: "C",
        bio: null,
        tier: "gold",
        level: 1,
        manager: null,
      },
    ]);
  });

  it("selects implementation fields and merges _count with the interface's", async () => {
    const { calls, e } = engine("Person", () => [
      {
        row: {
          name: "E",
          __labels: ["Employee", "Person"],
          _count: { notes: 3 },
          __on_Employee: { salary: 5, _count: { badges: 1 } },
        },
      },
    ]);
    const rows = await e.findMany({
      select: {
        name: true,
        _count: { select: { notes: true } },
        $on: { Employee: { salary: true, _count: { select: { badges: true } } } },
      },
    });
    expect(calls[0]!.text).toContain(
      "`__on_Employee`: CASE WHEN n:`Employee` THEN n{.`salary`, `_count`:",
    );
    expect(rows).toEqual([
      { __typename: "Employee", name: "E", salary: 5, _count: { notes: 3, badges: 1 } },
    ]);
  });

  it("works on relations whose target is an interface", async () => {
    const { calls, e } = engine("Team", () => []);
    await e.findMany({ include: { owner: { include: { $on: { Employee: { team: true } } } } } });
    expect(calls[0]!.text).toMatch(
      /`owner`: head\(COLLECT \{ MATCH \(n\)<-\[r\d+:`OWNS`\]-\(m(\d+):`Person`\) RETURN m\1\{.*`__on_Employee`: CASE WHEN m\1:`Employee` THEN m\1\{`team`:/,
    );
  });

  it("rejects $on on a node, unknown implementations and scalars in include", async () => {
    const { e } = engine("Person");
    await expect(e.findMany({ include: { $on: { Team: {} } } })).rejects.toThrow(
      /include.\$on.Team: not an implementation of Person \(Employee, Customer\)/,
    );
    await expect(e.findMany({ include: { $on: { Employee: { salary: true } } } })).rejects.toThrow(
      /include only takes relations \("salary" is a scalar; use select.\$on.Employee/,
    );
    await expect(e.findMany({ select: { $on: { Employee: { nope: true } } } })).rejects.toThrow(
      /Unknown field "Employee.nope"/,
    );
    await expect(e.findMany({ include: { $on: true } })).rejects.toThrow(
      /takes \{ <implementation>/,
    );
    const { e: team } = engine("Team");
    await expect(team.findMany({ include: { $on: {} } })).rejects.toThrow(
      /Team is not an interface/,
    );
  });
});
