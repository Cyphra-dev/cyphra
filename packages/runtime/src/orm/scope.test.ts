import { describe, expect, it } from "vitest";
import type { DriverLike, TransactionLike } from "../client.js";
import { createClient, schemaModel } from "./__fixtures__/blog.gen.js";
import { schemaModel as interfacesSchema } from "./__fixtures__/interfaces.gen.js";
import { schemaModel as ondeleteSchema } from "./__fixtures__/ondelete.gen.js";
import { ModelEngine, type Executor, type Runner } from "./engine.js";
import neo4j from "neo4j-driver";
import { withEngineRules, withRawValues } from "./client.js";
import { CyphraValidationError } from "./errors.js";
import type { EngineRules } from "./scope.js";

type Call = { text: string; params: Record<string, unknown> };
type Row = Record<string, unknown>;

function engine(
  name: string,
  rules: EngineRules[],
  answer: (text: string) => Row[] = () => [],
  schema = schemaModel,
) {
  const calls: Call[] = [];
  const exec: Executor = async (text, params) => {
    calls.push({ text, params });
    return answer(text);
  };
  const runner: Runner = { read: (fn) => fn(exec), write: (fn) => fn(exec) };
  const model = schema.nodes.find((n) => n.name === name)!;
  return { calls, e: new ModelEngine(schema, model, runner, { rules }) };
}

const published: EngineRules = { Post: { read: { published: true } } };

describe("engine rules", () => {
  it("AND the read rule into the root, relation loads, relation filters, _count and orderBy", async () => {
    const { calls, e } = engine("User", [published]);
    await e.findMany({
      where: { posts: { some: { title: "a" } } },
      orderBy: { posts: { _count: "desc" } },
      select: { id: true, posts: { select: { id: true } }, _count: true },
    });
    const text = calls[0]!.text;
    // Relation filter: the hidden posts are not there.
    expect(text).toContain(
      "EXISTS { MATCH (n)-[:`AUTHORED`]->(m0:`Post`) WHERE (m0.`published` = $p0) AND (m0.`title` = $p1) }",
    );
    // The filter, the orderBy (paging and result order), the relation load and _count.
    expect(text.match(/`published` = \$p\d+/g)).toHaveLength(5);
    expect(text).toContain("COLLECT { MATCH (n)-[r");
    expect(Object.values(calls[0]!.params).filter((v) => v === true)).toHaveLength(5);
  });

  it("applies `every` and `none` to the visible related nodes only", async () => {
    const { calls, e } = engine("User", [published]);
    await e.count({ where: { posts: { every: { views: { gt: 1 } }, none: { title: "x" } } } });
    expect(calls[0]!.text).toBe(
      "MATCH (n:`User`) WHERE (NOT EXISTS { MATCH (n)-[:`AUTHORED`]->(m0:`Post`) WHERE (m0.`published` = $p1) AND (NOT (m0.`views` > $p0)) })" +
        " AND (NOT EXISTS { MATCH (n)-[:`AUTHORED`]->(m1:`Post`) WHERE (m1.`published` = $p2) AND (m1.`title` = $p3) }) RETURN count(n) AS c",
    );
  });

  it("filters the root of reads, counts and aggregates", async () => {
    const { calls, e } = engine("Post", [published], (t) =>
      t.includes("count(n) AS c") ? [{ c: 0 }] : [],
    );
    await e.findMany({ where: { views: 1 } });
    await e.count();
    await e.aggregate({ _count: true });
    for (const c of calls) expect(c.text).toMatch(/WHERE \(?n\.`published` = \$p0/);
  });

  it("restricts write targets with the update / delete rules, and connect targets with read", async () => {
    const rules: EngineRules = {
      Post: { update: { views: { lt: 10 } }, delete: false, read: { published: true } },
    };
    const { calls, e } = engine("Post", [rules], () => [{ c: 0 }]);
    await e.updateMany({ data: { title: "t" } });
    expect(calls[0]!.text).toBe(
      "MATCH (n:`Post`) WHERE n.`views` < $p0 SET n.`title` = $p1 RETURN count(n) AS c",
    );
    await e.deleteMany({ where: { title: "x" } });
    expect(calls[1]!.text).toBe(
      "MATCH (n:`Post`) WHERE (false) AND (n.`title` = $p0) DETACH DELETE n RETURN count(*) AS c",
    );
    const u = engine("User", [rules], (t) => [{ row: { id: "u1" }, ...countsOf(t) }]);
    await u.e.update({ where: { id: "u1" }, data: { posts: { connect: { id: "p1" } } } });
    expect(u.calls[0]!.text).toContain(
      "MATCH (b0:`Post`) WHERE (b0.`published` = $p1) AND (b0.`id` = $p2)",
    );
  });

  it("applies interface rules to implementations, and implementation rules through interfaces", async () => {
    const rules: EngineRules = {
      Person: { read: { name: { not: "hidden" } } },
      Employee: { read: { salary: { gt: 0 } } },
    };
    const viaInterface = engine("Person", [rules], () => [], interfacesSchema);
    await viaInterface.e.count();
    expect(viaInterface.calls[0]!.text).toBe(
      "MATCH (n:`Person`) WHERE (n.`name` <> $p0) AND (NOT n:`Employee` OR (n.`salary` > $p1)) RETURN count(n) AS c",
    );
    const direct = engine("Employee", [rules], () => [], interfacesSchema);
    await direct.e.count();
    expect(direct.calls[0]!.text).toBe(
      "MATCH (n:`Employee`:`Person`:`Archivable`) WHERE (n.`salary` > $p0) AND (n.`name` <> $p1) RETURN count(n) AS c",
    );
  });

  it("does not apply rules inside a rule's own where", async () => {
    const rules: EngineRules = {
      Post: { read: { author: { is: { email: { endsWith: "@acme.io" } } } } },
      User: { read: { posts: { some: { published: true } } } },
    };
    const { calls, e } = engine("Post", [rules]);
    await e.count();
    // The User rule does not apply to the author the Post rule looks at (no recursion).
    expect(calls[0]!.text).toBe(
      "MATCH (n:`Post`) WHERE EXISTS { MATCH (n)<-[:`AUTHORED`]-(m0:`User`) WHERE m0.`email` ENDS WITH $p0 } RETURN count(n) AS c",
    );
  });

  it("ANDs several rule sets; true adds nothing, false matches nothing", async () => {
    const { calls, e } = engine("Post", [
      published,
      { Post: { read: true } },
      { Post: { read: { views: 1 } } },
    ]);
    await e.count();
    expect(calls[0]!.text).toBe(
      "MATCH (n:`Post`) WHERE (n.`published` = $p0) AND (n.`views` = $p1) RETURN count(n) AS c",
    );
    const denied = engine("Post", [{ Post: { read: false } }]);
    await denied.e.count();
    expect(denied.calls[0]!.text).toBe("MATCH (n:`Post`) WHERE false RETURN count(n) AS c");
  });
});

/** `c<n>: 1` for every nested connect count of `text`, so that the connects pass their check. */
function countsOf(text: string): Row {
  return Object.fromEntries([...text.matchAll(/count\(\w+\) AS (c\d+)/g)].map((m) => [m[1]!, 1]));
}

/** In-memory driver: every statement returns `rows(text)`. */
function fakeDriver(rows: (text: string) => Row[]) {
  const calls: string[] = [];
  const run = async (text: string) => {
    calls.push(text);
    const out = rows(text);
    return {
      records: out.map((r) => ({ toObject: () => r, get: (k: string) => r[k] })),
      summary: { server: { address: "db.example.com:7687" }, database: { name: "neo4j" } },
    };
  };
  const tx: TransactionLike = { run };
  const driver: DriverLike = {
    session: () => ({
      run,
      executeRead: async (work) => work(tx),
      executeWrite: async (work) => work(tx),
      close: async () => {},
    }),
    close: async () => {},
  };
  return { driver, calls };
}

describe("withEngineRules", () => {
  const user = { id: "u1", email: "a@x.io", name: null, age: null, tags: [], createdAt: null };

  it("returns a client whose statements carry the rules; the original client is unchanged", async () => {
    const fake = fakeDriver(() => [{ row: user }]);
    const db = createClient({ driver: fake.driver });
    const scoped = withEngineRules(db, { User: { read: { email: { endsWith: "@x.io" } } } });
    await scoped.user.findMany();
    await db.user.findMany();
    expect(fake.calls[0]).toContain("WHERE n.`email` ENDS WITH $p0");
    expect(fake.calls[1]).not.toContain("WHERE");
  });

  it("keeps the rules through $extends, $transaction and further withEngineRules (never removed)", async () => {
    const fake = fakeDriver(() => [{ row: user }]);
    const db = createClient({ driver: fake.driver });
    const scoped = withEngineRules(db, { User: { read: { name: "a" } } });
    const extended = scoped.$extends({
      query: { user: { findMany: ({ args, query }) => query({ ...args, where: undefined }) } },
    });
    await extended.user.findMany({ where: { age: 1 } });
    expect(fake.calls[0]).toContain("WHERE n.`name` = $p0");
    await extended.$transaction((tx) => tx.user.findMany());
    expect(fake.calls[1]).toContain("WHERE n.`name` = $p0");
    const both = withEngineRules(extended, { User: { read: true } });
    await both.user.findMany();
    expect(fake.calls[2]).toContain("WHERE n.`name` = $p0");
  });

  it("checks the rules against the schema", () => {
    const db = createClient({ driver: fakeDriver(() => []).driver });
    expect(() => withEngineRules(db, { Nope: { read: true } })).toThrow(/unknown model "Nope"/);
    expect(() => withEngineRules(db, { User: { write: true } } as never)).toThrow(
      /unknown operation "write"/,
    );
    expect(() => withEngineRules(db, { User: { read: "yes" } } as never)).toThrow(
      CyphraValidationError,
    );
    expect(() => withEngineRules({}, {})).toThrow(/not a Cyphra ORM client/);
  });
});

describe("withRawValues", () => {
  const raw = {
    id: "u1",
    email: "a@x.io",
    name: null,
    age: neo4j.int(41),
    tags: null,
    createdAt: new neo4j.types.DateTime(2024, 1, 2, 3, 4, 5, 6_000_000, 3600),
  };

  it("returns node and edge properties as the driver gives them; the original client decodes", async () => {
    const since = new neo4j.types.DateTime(2020, 1, 1, 0, 0, 0, 0, 0);
    const fake = fakeDriver(() => [
      { row: { ...raw, following: [{ ...raw, id: "u2", $edge: { since } }] } },
    ]);
    const db = createClient({ driver: fake.driver });
    const rawDb = withRawValues(db);
    const args = { select: { id: true, age: true, tags: true, createdAt: true, following: true } };
    const [r] = (await rawDb.user.findMany(args)) as unknown as Record<string, unknown>[];
    expect(r!.age).toBe(raw.age);
    expect(r!.tags).toBeNull();
    expect(r!.createdAt).toBe(raw.createdAt);
    const following = (r!.following as Record<string, unknown>[])[0]!;
    expect(following.age).toBe(raw.age);
    expect((following.$edge as Record<string, unknown>).since).toBe(since);
    const [d] = (await db.user.findMany(args)) as unknown as Record<string, unknown>[];
    expect(d!.age).toBe(41);
    expect(d!.tags).toEqual([]);
    expect(d!.createdAt).toBeInstanceOf(Date);
  });

  it("keeps rules, extensions and transactions, and composes with withEngineRules", async () => {
    const fake = fakeDriver(() => [{ row: raw }]);
    const db = withEngineRules(createClient({ driver: fake.driver }), {
      User: { read: { name: "a" } },
    });
    const rawDb = withEngineRules(withRawValues(db), { User: { read: { email: "a@x.io" } } });
    const rows = (await rawDb.$transaction((tx) => tx.user.findMany())) as unknown as Record<
      string,
      unknown
    >[];
    expect(rows[0]!.age).toBe(raw.age);
    expect(fake.calls[0]).toContain("n.`name` = $p0");
    expect(fake.calls[0]).toContain("n.`email` = $p1");
    expect(() => withRawValues({})).toThrow(/not a Cyphra ORM client/);
  });
});

describe("deleteMany $relationships (internal)", () => {
  it("counts the distinct relationships the delete removes, in the same statement", async () => {
    const { calls, e } = engine("User", [], () => [
      { c: 2, rels: 3, nodes: [{ id: "a" }, { id: "b" }] },
    ]);
    const res = await e.deleteMany({
      where: { name: "x" },
      $relationships: true,
      select: { id: true },
    } as never);
    expect(res).toEqual({ count: 2, relationships: 3, nodes: [{ id: "a" }, { id: "b" }] });
    expect(calls[0]!.text).toBe(
      "MATCH (n:`User`) WHERE n.`name` = $p0 WITH collect(n) AS ns, collect(n{.`id`}) AS nodes" +
        " WITH ns, nodes, COUNT { UNWIND ns AS x MATCH (x)-[e]-() RETURN DISTINCT e } AS rels" +
        " FOREACH (x IN ns | DETACH DELETE x) RETURN size(ns) AS c, rels, nodes",
    );
    await expect(e.deleteMany({ $relationships: 1 } as never)).rejects.toThrow(/takes true/);
  });

  it("refuses models with onDelete rules and other dialects", async () => {
    const { e } = engine("OdUser", [], () => [], ondeleteSchema);
    await expect(e.deleteMany({ $relationships: true } as never)).rejects.toThrow(
      /without onDelete rules/,
    );
  });
});

describe("aliased relation loads", () => {
  it("loads one relation several times with different arguments, under its aliases", async () => {
    const { calls, e } = engine("User", [published], () => [
      {
        row: {
          id: "u1",
          recent: [{ title: "new" }],
          popular: [{ title: "hot" }, { title: "warm" }],
        },
      },
    ]);
    const [row] = await e.findMany({
      select: {
        id: true,
        recent: { $relation: "posts", take: 1, select: { title: true } },
        popular: {
          $relation: "posts",
          orderBy: { views: "desc" },
          take: 2,
          select: { title: true },
        },
      },
    });
    expect(row).toEqual({
      id: "u1",
      recent: [{ title: "new" }],
      popular: [{ title: "hot" }, { title: "warm" }],
    });
    const text = calls[0]!.text;
    expect(text).toContain(
      "`recent`: COLLECT { MATCH (n)-[r1:`AUTHORED`]->(m0:`Post`) WHERE m0.`published` = $p0 WITH m0, r1 LIMIT $p1",
    );
    expect(text).toContain(
      "`popular`: COLLECT { MATCH (n)-[r3:`AUTHORED`]->(m2:`Post`) WHERE m2.`published` = $p2 WITH m2, r3 ORDER BY m2.`views` DESC LIMIT $p3",
    );
  });

  it("works for to-one relations, inside include, and nested", async () => {
    const { calls, e } = engine("Post", [], () => [
      { row: { id: "p1", writer: { email: "a@x.io", latest: [{ id: "p1" }] } } },
    ]);
    const [row] = await e.findMany({
      select: {
        id: true,
        writer: {
          $relation: "author",
          select: { email: true, latest: { $relation: "posts", take: 1, select: { id: true } } },
        },
      },
    });
    expect(row).toEqual({ id: "p1", writer: { email: "a@x.io", latest: [{ id: "p1" }] } });
    expect(calls[0]!.text).toContain("`writer`: head(COLLECT {");
    await e.findMany({ include: { writer: { $relation: "author" } } });
    expect(calls[1]!.text).toContain("`writer`: head(COLLECT {");
  });

  it("rejects unknown relations and aliases that would clash", async () => {
    const { calls, e } = engine("User", []);
    await expect(e.findMany({ select: { x: { $relation: "nope" } } })).rejects.toThrow(
      /"nope" is not a relation of User/,
    );
    await expect(e.findMany({ select: { x: { $relation: 3 } } })).rejects.toThrow(
      /must be a relation name/,
    );
    await expect(e.findMany({ include: { email: { $relation: "posts" } } })).rejects.toThrow(
      /a scalar field of User/,
    );
    for (const alias of ["_count", "$edge", "__labels"]) {
      await expect(e.findMany({ select: { [alias]: { $relation: "posts" } } })).rejects.toThrow(
        /reserved key|_count on User/,
      );
    }
    expect(calls).toHaveLength(0);
  });

  it("computes the computed fields of aliased loads", async () => {
    const fake = fakeDriver(() => [{ row: { id: "u1", mine: [{ title: "a", views: 2 }] } }]);
    const db = createClient({ driver: fake.driver }).$extends({
      result: { post: { loud: { needs: { title: true }, compute: (p) => p.title.toUpperCase() } } },
    });
    const rows = (await db.user.findMany({
      select: { id: true, mine: { $relation: "posts", select: { loud: true, views: true } } },
    } as never)) as unknown as { mine: { loud: string; title?: string }[] }[];
    expect(rows[0]!.mine[0]).toEqual({ loud: "A", views: 2 });
    expect(fake.calls[0]).toContain("`mine`: COLLECT {");
    expect(fake.calls[0]).toContain(".`title`");
  });
});
