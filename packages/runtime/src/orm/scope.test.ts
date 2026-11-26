import { describe, expect, it } from "vitest";
import type { DriverLike, TransactionLike } from "../client.js";
import { createClient, schemaModel } from "./__fixtures__/blog.gen.js";
import { schemaModel as interfacesSchema } from "./__fixtures__/interfaces.gen.js";
import { schemaModel as ondeleteSchema } from "./__fixtures__/ondelete.gen.js";
import { ModelEngine, type Executor, type Runner } from "./engine.js";
import neo4j from "neo4j-driver";
import { withEngineRules, withRawValues } from "./client.js";
import { CyphraValidationError, ForbiddenError } from "./errors.js";
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

  it("restricts write targets with the read and update / delete rules, and connect targets with read", async () => {
    const rules: EngineRules = {
      Post: { update: { views: { lt: 10 } }, delete: false, read: { published: true } },
    };
    const { calls, e } = engine("Post", [rules], () => [{ c: 0 }]);
    await e.updateMany({ data: { title: "t" } });
    // A node the request cannot read does not exist for it: read applies to write targets too.
    expect(calls[0]!.text).toBe(
      "MATCH (n:`Post`) WHERE (n.`published` = $p0) AND (n.`views` < $p1) SET n.`title` = $p2 RETURN count(n) AS c",
    );
    await e.deleteMany({ where: { title: "x" } });
    expect(calls[1]!.text).toBe(
      "MATCH (n:`Post`) WHERE (n.`published` = $p0) AND (false) AND (n.`title` = $p1) DETACH DELETE n RETURN count(*) AS c",
    );
    const u = engine("User", [rules], (t) => [{ row: { id: "u1" }, ...countsOf(t) }]);
    await u.e.update({ where: { id: "u1" }, data: { posts: { connect: { id: "p1" } } } });
    expect(u.calls[0]!.text).toContain(
      // Post.author is to-one: the connected post's author is replaced, so its update rule applies.
      "MATCH (b0:`Post`) WHERE ((b0.`published` = $p1) AND (b0.`id` = $p2)) AND (b0.`views` < $p3)",
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

/** A row that passes every check of `text`: connect counts, `after` checks, no denied node. */
function passing(text: string, extra: Row = {}): Row[] {
  const oks = [...text.matchAll(/ AS (ok\d*)\b/g)].map((m) => [m[1]!, true]);
  return [
    { row: { id: "x" }, c: 1, denied: 0, ...countsOf(text), ...Object.fromEntries(oks), ...extra },
  ];
}

describe("engine rules: create, connect, disconnect, after", () => {
  it("checks create rules on every node a write creates, before anything runs", async () => {
    const rules: EngineRules = {
      User: { create: (d) => d.email !== "no@x.io" },
      Post: { create: false },
    };
    const user = engine("User", [rules], (t) => passing(t));
    await user.e.create({ data: { email: "a@x.io" } });
    expect(user.calls).toHaveLength(1);
    await expect(user.e.create({ data: { email: "no@x.io" } })).rejects.toThrow(ForbiddenError);
    // A nested create of a model whose create rule is false.
    await expect(
      user.e.create({ data: { email: "a@x.io", posts: { create: [{ title: "t" }] } } }),
    ).rejects.toMatchObject({ name: "ForbiddenError", model: "Post", operation: "create" });
    await expect(
      user.e.createMany({ data: [{ email: "a@x.io" }, { email: "no@x.io" }] }),
    ).rejects.toThrow(ForbiddenError);
    // An upsert may create: the create rule applies whatever it ends up doing.
    await expect(
      user.e.upsert({ where: { email: "no@x.io" }, create: { email: "no@x.io" }, update: {} }),
    ).rejects.toThrow(ForbiddenError);
    expect(user.calls).toHaveLength(1);
  });

  it("restricts connect targets with the connect rule, and with update when their edge is replaced", async () => {
    const rules: EngineRules = {
      User: { connect: { posts: { title: { startsWith: "ok" } } } },
      Post: { update: { views: 0 } },
    };
    const { calls, e } = engine("User", [rules], (t) => passing(t));
    await e.update({ where: { id: "u1" }, data: { posts: { connect: [{ id: "p1" }] } } });
    // Post.author is to-one: connecting a post replaces its author, an update of the post.
    expect(calls[0]!.text).toContain(
      "MATCH (b0:`Post`) WHERE (b0.`id` = $p1) AND (b0.`title` STARTS WITH $p2) AND (b0.`views` = $p3)",
    );
  });

  it("restricts disconnect and set with the disconnect rule; a to-one replace outside it is forbidden", async () => {
    const rules: EngineRules = {
      User: { disconnect: { posts: { views: 0 } } },
      Post: { disconnect: { author: { email: { endsWith: "@x.io" } } } },
    };
    const user = engine("User", [rules], (t) => passing(t));
    await user.e.update({
      where: { id: "u1" },
      data: { posts: { disconnect: [{ id: "p1" }], set: [{ id: "p2" }] } },
    });
    expect(user.calls[0]!.text).toContain(
      "MATCH (n)-[r1:`AUTHORED`]->(b0:`Post`) WHERE ((b0.`id` = $p1)) AND (b0.`views` = $p2) DELETE r1",
    );
    expect(user.calls[0]!.text).toContain(
      "MATCH (n)-[r4:`AUTHORED`]->(b3:`Post`) WHERE (NOT ((b3.`id` = $p3))) AND (b3.`views` = $p4) DELETE r4",
    );
    // Replacing the author (connect or create on a to-one): the current one must be disconnectable.
    const post = engine("Post", [rules], (t) => passing(t, { f0: 0, f1: 0, f2: 0, f3: 1 }));
    await expect(
      post.e.update({ where: { id: "p1" }, data: { author: { connect: { id: "u2" } } } }),
    ).rejects.toMatchObject({
      name: "ForbiddenError",
      operation: "disconnect",
      relation: "author",
    });
    expect(post.calls[0]!.text).toContain(
      "CALL { WITH n MATCH (n)<-[:`AUTHORED`]-(x2:`User`) WHERE (NOT coalesce(x2.`email` ENDS WITH $p1, false)) AND (NOT coalesce(x2.`id` = $p2, false)) RETURN count(x2) AS f3 }",
    );
    // `disconnect: true` drops the edge only when its target is within the rule.
    await post.e.update({ where: { id: "p1" }, data: { author: { disconnect: true } } });
    expect(post.calls[1]!.text).toContain(
      "MATCH (n)<-[r1:`AUTHORED`]-(b0:`User`) WHERE b0.`email` ENDS WITH $p1 DELETE r1",
    );
  });

  it("checks after rules once every write of the statement ran, and fails with ForbiddenError", async () => {
    const rules: EngineRules = {
      Post: { after: { create: { author: { is: { id: "me" } } }, update: { views: { lt: 100 } } } },
    };
    const post = engine("Post", [rules], (t) => passing(t));
    await post.e.create({ data: { title: "t", author: { connect: { id: "me" } } } });
    const create = post.calls[0]!.text;
    // Checked in the RETURN, after the connect subquery.
    expect(create).toMatch(
      /MERGE \(n\)<-\[r1:`AUTHORED`\]-\(b0\) RETURN count\(r1\) AS c4 \} RETURN .* AS row, c4, coalesce\(EXISTS \{ MATCH \(n\)<-\[:`AUTHORED`\]-\(m5:`User`\) WHERE m5.`id` = \$p2 \}, false\) AS ok6$/,
    );
    const denied = engine("Post", [rules], (t) => passing(t, { ok0: false }));
    await expect(
      denied.e.update({ where: { id: "p1" }, data: { views: 500 } }),
    ).rejects.toMatchObject({ name: "ForbiddenError", operation: "after.update" });
    expect(denied.calls[0]!.text).toContain("coalesce(n.`views` < $p2, false) AS ok0");
    const many = engine("Post", [rules], () => [{ c: 2, denied: 1 }]);
    await expect(many.e.updateMany({ data: { views: 500 } })).rejects.toThrow(ForbiddenError);
    expect(many.calls[0]!.text).toContain(
      "sum(CASE WHEN coalesce(n.`views` < $p1, false) THEN 0 ELSE 1 END) AS denied",
    );
    await expect(many.e.createMany({ data: [{ title: "a" }] })).rejects.toThrow(ForbiddenError);
    expect(many.calls[1]!.text).toContain("AS d0 RETURN c0 AS c, d0 AS denied");
    // A nested create is created on its own, to be checked by name.
    const user = engine("User", [rules], (t) => passing(t));
    await user.e.create({ data: { email: "a@x.io", posts: { create: [{ title: "x" }] } } });
    expect(user.calls[0]!.text).toContain(
      "CREATE (c0:`Post` $p1) CREATE (n)-[:`AUTHORED`]->(c0) RETURN",
    );
    expect(user.calls[0]!.text).toContain(
      "coalesce(EXISTS { MATCH (c0)<-[:`AUTHORED`]-(m1:`User`) WHERE m1.`id` = $p2 }, false) AS ok2",
    );
    // An upsert checks the rule of what it did.
    const upsert = engine("Post", [rules], () => [{ id: "e", created: true, ok: false, row: {} }]);
    await expect(
      upsert.e.upsert({ where: { id: "p" }, create: { title: "a" }, update: { title: "b" } }),
    ).rejects.toMatchObject({ operation: "after.create" });
  });

  it("returns a written node only when the read rules show it", async () => {
    const { calls, e } = engine("Post", [published], () => [{ row: null, c: 1, nodes: [null] }]);
    expect(await e.create({ data: { title: "t" } })).toBeNull();
    expect(calls[0]!.text).toContain("RETURN CASE WHEN n.`published` = $p1 THEN n{");
    expect(await e.updateMany({ data: { title: "t" }, select: { id: true } })).toEqual({
      count: 1,
      nodes: [],
    });
  });
});

describe("engine rules: field rules", () => {
  const rules: EngineRules = { User: { fields: { email: { name: "me" }, age: false } } };

  it("reads a ruled field as null outside its rule: projections, filters, orderBy", async () => {
    const { calls, e } = engine("User", [rules]);
    await e.findMany({
      where: { email: { contains: "x" }, age: 3 },
      orderBy: { email: "asc" },
      select: { email: true, age: true, name: true },
    });
    const text = calls[0]!.text;
    expect(text).toContain("(CASE WHEN n.`name` = $p0 THEN n.`email` END CONTAINS $p1)");
    expect(text).toContain("(null = $p2)");
    expect(text).toContain("ORDER BY CASE WHEN n.`name` = $p3 THEN n.`email` END ASC");
    expect(text).toContain(
      "RETURN n{`email`: CASE WHEN n.`name` = $p4 THEN n.`email` END, `age`: null, .`name`} AS row",
    );
  });

  it("applies to aggregates, groupBy keys, relation sorts and to-one relation loads", async () => {
    const user = engine("User", [rules], () => [{ a0: null, a1: null }]);
    await user.e.aggregate({ _max: { age: true, email: true } });
    expect(user.calls[0]!.text).toContain("max(null)");
    expect(user.calls[0]!.text).toContain("max(CASE WHEN n.`name` = $p0 THEN n.`email` END)");
    await user.e.groupBy({ by: ["email"], _count: { _all: true } });
    expect(user.calls[1]!.text).toContain("CASE WHEN n.`name` = $p0 THEN n.`email` END AS k0");
    const post = engine("Post", [rules]);
    await post.e.findMany({ orderBy: { author: { email: "desc" } }, select: { author: true } });
    expect(post.calls[0]!.text).toContain(
      "RETURN CASE WHEN m0.`name` = $p0 THEN m0.`email` END })",
    );
    expect(post.calls[0]!.text).toContain("`email`: CASE WHEN m");
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
    expect(() => withEngineRules(db, { User: { fields: { posts: true } } })).toThrow(
      /rules.User.fields.posts: not a scalar field of User/,
    );
    expect(() => withEngineRules(db, { User: { connect: { email: true } } })).toThrow(
      /not a relation field of User/,
    );
    expect(() => withEngineRules(db, { User: { after: { delete: true } } } as never)).toThrow(
      /unknown key "delete"/,
    );
    expect(() => withEngineRules(db, { User: { create: {} } } as never)).toThrow(
      /must be a boolean or a function/,
    );
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
