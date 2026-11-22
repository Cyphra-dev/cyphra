import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createClient, type Db } from "./__fixtures__/interfaces.gen.js";
import {
  createClient as createNestedClient,
  type Db as NestedDb,
} from "./__fixtures__/nested.gen.js";
import { CyphraValidationError } from "./errors.js";
import {
  onFalkorDB,
  onMemgraph,
  testDdl,
  hasTestDb,
  testConnection,
} from "./__fixtures__/testDialect.js";

// Each test makes many round trips to Neo4j: the default 5 s is too tight on a busy CI runner.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const hasNeo = hasTestDb;

const LABELS = ["Person", "Archivable", "Employee", "Customer", "Team", "Note", "Badge"];

describe.skipIf(!hasNeo)("interfaces and multiple labels (Neo4j)", () => {
  let db: Db;

  beforeEach(async () => {
    db ??= createClient({
      ...testConnection(),
    });
    await db.$cypher`MATCH (n) WHERE any(l IN labels(n) WHERE l IN ${LABELS}) DETACH DELETE n`;
  });

  afterAll(async () => {
    if (!db) return;
    await db.$cypher`MATCH (n) WHERE any(l IN labels(n) WHERE l IN ${LABELS}) DETACH DELETE n`;
    if (!onMemgraph && !onFalkorDB) await db.$cypher`DROP INDEX personSearch IF EXISTS`;
    if (onFalkorDB) {
      await db.$cypher`DROP FULLTEXT INDEX FOR (n:Person) ON (n.name)`.catch(() => undefined);
      await db.$cypher`DROP FULLTEXT INDEX FOR (n:Person) ON (n.bio)`.catch(() => undefined);
    }
    await db.$disconnect();
  });

  async function seed() {
    const boss = await db.customer.create({
      data: { email: "boss@x.io", name: "Ada Boss", tier: "gold", level: 3 },
    });
    const team = await db.team.create({ data: { name: "core" } });
    const emp = await db.employee.create({
      data: {
        email: "emp@x.io",
        name: "Bob Worker",
        salary: 100,
        manager: { connect: { email: "boss@x.io" } },
        team: { connect: { id: team.id } },
        notes: { create: [{ text: "n1" }, { text: "n2" }] },
        badges: { create: { name: "b1" } },
      },
    });
    return { boss, team, emp };
  }

  it("writes every label of an implementation", async () => {
    await seed();
    const rows = await db.$cypher<{ labels: string[] }>`
      MATCH (n:Person) RETURN labels(n) AS labels ORDER BY n.email`;
    expect(rows.map((r) => [...r.labels].sort())).toEqual([
      ["Customer", "Person"],
      ["Archivable", "Employee", "Person"],
    ]);
  });

  it("queries an interface as a union discriminated by __typename", async () => {
    await seed();
    const people = await db.person.findMany({ orderBy: { email: "asc" } });
    expect(people).toEqual([
      {
        __typename: "Customer",
        id: expect.any(String),
        email: "boss@x.io",
        name: "Ada Boss",
        bio: null,
        tier: "gold",
        level: 3,
      },
      {
        __typename: "Employee",
        id: expect.any(String),
        email: "emp@x.io",
        name: "Bob Worker",
        bio: null,
        salary: 100,
      },
    ]);
    expect(await db.person.count({ where: { name: { contains: "o" } } })).toBe(2);
    expect(await db.archivable.count()).toBe(1);
    const selected = await db.person.findMany({ select: { name: true }, orderBy: { name: "asc" } });
    expect(selected).toEqual([
      { __typename: "Customer", name: "Ada Boss" },
      { __typename: "Employee", name: "Bob Worker" },
    ]);
  });

  it("filters, includes and counts through interface relations", async () => {
    await seed();
    const boss = await db.person.findUniqueOrThrow({
      where: { email: "boss@x.io" },
      include: { reports: true, _count: true },
    });
    expect(boss.__typename).toBe("Customer");
    expect(boss.reports).toEqual([
      expect.objectContaining({ __typename: "Employee", salary: 100 }),
    ]);
    expect(boss._count).toEqual({ reports: 1, notes: 0 });
    const managed = await db.person.findMany({
      where: { manager: { is: { email: "boss@x.io" } } },
      select: { email: true, manager: { select: { name: true } } },
    });
    expect(managed).toEqual([
      {
        __typename: "Employee",
        email: "emp@x.io",
        manager: { __typename: "Customer", name: "Ada Boss" },
      },
    ]);
    const team = await db.team.findFirst({ include: { members: true } });
    expect(team?.members.map((m) => m.email)).toEqual(["emp@x.io"]);
    const agg = await db.person.aggregate({ _count: true });
    expect(agg._count).toBe(2);
  });

  it("matches a concrete model only on all its labels", async () => {
    await seed();
    // An Employee missing the interface label (data from before the interface) is not an Employee.
    await db.$cypher`CREATE (:Employee {id: 'legacy', email: 'old@x.io', name: 'Old', salary: 1})`;
    expect(await db.employee.count()).toBe(1);
    await db.$cypher`MATCH (n:Employee) WHERE NOT n:Person SET n:Person:Archivable`;
    expect(await db.employee.count()).toBe(2);
  });

  it("refuses to create an interface, updates and deletes through it", async () => {
    await seed();
    await expect(
      // @ts-expect-error interfaces have no create
      db.person.create({ data: { email: "x@x.io", name: "X" } }),
    ).rejects.toThrow(CyphraValidationError);
    await db.person.update({ where: { email: "emp@x.io" }, data: { bio: "hello" } });
    expect((await db.employee.findUniqueOrThrow({ where: { email: "emp@x.io" } })).bio).toBe(
      "hello",
    );
    expect(await db.person.updateMany({ data: { bio: "all" } })).toEqual({ count: 2 });
  });

  it("applies the implementation's onDelete rules when deleting through the interface", async () => {
    await seed();
    // Employee.badges and the inherited Person.notes cascade.
    await db.person.delete({ where: { email: "emp@x.io" } });
    expect(await db.note.count()).toBe(0);
    expect(await db.badge.count()).toBe(0);
    expect(await db.team.count()).toBe(1);
    expect(await db.person.count()).toBe(1);
  });

  it("traverses interface relations", async () => {
    await seed();
    await db.employee.create({
      data: { email: "e2@x.io", name: "Eve", manager: { connect: { email: "emp@x.io" } } },
    });
    const below = await db.person.traverse({
      from: { email: "boss@x.io" },
      via: "reports",
      depth: { max: 3 },
      orderBy: { email: "asc" },
      returnPaths: true,
    });
    expect(below.map((r) => [r.node.__typename, r.node.email, r.path.nodes.length])).toEqual([
      ["Employee", "e2@x.io", 3],
      ["Employee", "emp@x.io", 2],
    ]);
    const path = await db.person.shortestPath({
      from: { email: "e2@x.io" },
      to: { email: "boss@x.io" },
      via: "manager",
      maxDepth: 3,
    });
    expect(path?.nodes.map((n) => n.email)).toEqual(["e2@x.io", "emp@x.io", "boss@x.io"]);
  });

  it("enforces an interface uniqueness constraint across implementations", async () => {
    // Outside a transaction: Memgraph rejects DDL in explicit transactions.
    const ddl = (text: string) =>
      db.$client.withSession(async (s) => {
        await s.run(testDdl(text)!);
      });
    await ddl(
      "CREATE CONSTRAINT Person_email_unique IF NOT EXISTS FOR (n:Person) REQUIRE n.email IS UNIQUE",
    );
    try {
      await db.customer.create({ data: { email: "same@x.io", name: "C" } });
      await expect(
        db.employee.create({ data: { email: "same@x.io", name: "E" } }),
      ).rejects.toThrow();
    } finally {
      await ddl("DROP CONSTRAINT Person_email_unique IF EXISTS");
    }
  });

  // Memgraph's text search has its own suite (memgraph.integration.test.ts).
  it.skipIf(onMemgraph)(
    "searches an interface full-text index, through the interface and an implementation",
    async () => {
      // FalkorDB: one statement per property (a multi-property one is all-or-nothing), each
      // possibly indexed by an earlier run.
      const ddl = onFalkorDB
        ? ["name", "bio"].map((p) => `CREATE FULLTEXT INDEX FOR (n:Person) ON (n.${p})`)
        : [
            testDdl(
              "CREATE FULLTEXT INDEX personSearch IF NOT EXISTS FOR (n:Person) ON EACH [n.name, n.bio]",
            )!,
          ];
      await db.$client.withSession(async (s) => {
        for (const statement of ddl) {
          await s.run(statement).catch((e: unknown) => {
            if (!(onFalkorDB && /already indexed/i.test(String(e)))) throw e;
          });
        }
      });
      if (!onFalkorDB) await db.$cypher`CALL db.awaitIndexes(60)`;
      await seed();
      await db.customer.create({ data: { email: "c2@x.io", name: "Bob Buyer" } });
      // Full-text indexes are eventually visible: retry briefly.
      let hits: { __typename: string }[] = [];
      for (let i = 0; i < 50 && hits.length < 2; i++) {
        hits = await db.person.search({ index: "personSearch", query: "bob" });
        if (hits.length < 2) await new Promise((r) => setTimeout(r, 100));
      }
      expect(hits.map((h) => h.__typename).sort()).toEqual(["Customer", "Employee"]);
      const employees = await db.employee.search({ index: "personSearch", query: "bob" });
      expect(employees.map((h) => h.email)).toEqual(["emp@x.io"]);
    },
  );
});

describe.skipIf(!hasNeo)("interfaces: __typename filters and $on (Neo4j)", () => {
  let db: Db;

  beforeEach(async () => {
    db ??= createClient({
      ...testConnection(),
    });
    await db.$cypher`MATCH (n) WHERE any(l IN labels(n) WHERE l IN ${LABELS}) DETACH DELETE n`;
    const team = await db.team.create({ data: { name: "core" } });
    await db.customer.create({
      data: { email: "c@x.io", name: "Cleo", tier: "gold", notes: { create: { text: "hi" } } },
    });
    await db.employee.create({
      data: {
        email: "e@x.io",
        name: "Eve",
        salary: 10,
        team: { connect: { id: team.id } },
        manager: { connect: { email: "c@x.io" } },
        badges: { create: [{ name: "b1" }, { name: "b2" }] },
      },
    });
  });

  afterAll(async () => {
    if (!db) return;
    await db.$cypher`MATCH (n) WHERE any(l IN labels(n) WHERE l IN ${LABELS}) DETACH DELETE n`;
    await db.$disconnect();
  });

  it("filters and sorts an interface query by __typename", async () => {
    const employees = await db.person.findMany({ where: { __typename: "Employee" } });
    expect(employees.map((p) => [p.__typename, p.email])).toEqual([["Employee", "e@x.io"]]);
    expect(await db.person.count({ where: { __typename: { in: ["Employee", "Customer"] } } })).toBe(
      2,
    );
    expect(await db.person.count({ where: { __typename: { notIn: ["Employee"] } } })).toBe(1);
    expect(await db.person.count({ where: { __typename: { in: [] } } })).toBe(0);
    const desc = await db.person.findMany({
      orderBy: { __typename: "desc" },
      select: { email: true },
    });
    expect(desc.map((p) => p.__typename)).toEqual(["Employee", "Customer"]);
    const managed = await db.person.findMany({
      where: { manager: { is: { __typename: "Customer" } } },
      select: { email: true },
    });
    expect(managed).toEqual([{ __typename: "Employee", email: "e@x.io" }]);
  });

  it("loads per-implementation relations and fields with $on", async () => {
    const people = await db.person.findMany({
      orderBy: { email: "asc" },
      include: {
        manager: { select: { name: true } },
        $on: {
          Employee: { team: true, badges: { orderBy: { name: "desc" }, take: 1 } },
          Customer: { _count: { select: { notes: true } } },
        },
      },
    });
    const [c, e] = people;
    expect(c).toMatchObject({ __typename: "Customer", manager: null, _count: { notes: 1 } });
    expect(c).not.toHaveProperty("team");
    expect(e).toMatchObject({
      __typename: "Employee",
      salary: 10,
      manager: { __typename: "Customer", name: "Cleo" },
      team: { name: "core" },
      badges: [{ name: "b2" }],
    });
    expect(e).not.toHaveProperty("_count");

    const selected = await db.person.findMany({
      orderBy: { email: "asc" },
      select: { name: true, $on: { Employee: { salary: true, team: { select: { name: true } } } } },
    });
    expect(selected).toEqual([
      { __typename: "Customer", name: "Cleo" },
      { __typename: "Employee", name: "Eve", salary: 10, team: { name: "core" } },
    ]);

    // Through a relation whose target is an interface.
    const team = (await db.team.findFirst({
      include: {
        members: { include: { manager: { include: { $on: { Customer: { notes: true } } } } } },
      },
    }))!;
    expect(team.members[0]!.manager).toMatchObject({
      __typename: "Customer",
      notes: [{ text: "hi" }],
    });
  });
});

describe.skipIf(!hasNeo)("interfaces extending interfaces (Neo4j)", () => {
  const NESTED_LABELS = [
    "Party",
    "Staffer",
    "Reachable",
    "Engineer",
    "Temp",
    "Buyer",
    "Unit",
    "Task",
  ];
  let db: NestedDb;

  beforeEach(async () => {
    db ??= createNestedClient({
      ...testConnection(),
    });
    await db.$cypher`MATCH (n) WHERE any(l IN labels(n) WHERE l IN ${NESTED_LABELS}) DETACH DELETE n`;
  });

  afterAll(async () => {
    if (!db) return;
    await db.$cypher`MATCH (n) WHERE any(l IN labels(n) WHERE l IN ${NESTED_LABELS}) DETACH DELETE n`;
    await db.$disconnect();
  });

  async function seed() {
    const unit = await db.unit.create({ data: { name: "core" } });
    await db.buyer.create({ data: { email: "b@x.io", name: "Bea", phone: "1" } });
    await db.engineer.create({
      data: {
        email: "e@x.io",
        name: "Eli",
        badge: "E1",
        phone: "2",
        level: 3,
        unit: { connect: { id: unit.id } },
        manager: { connect: { email: "b@x.io" } },
        tasks: { create: { title: "t1" } },
      },
    });
    await db.temp.create({
      data: { email: "t@x.io", name: "Tom", agency: "acme", unit: { connect: { id: unit.id } } },
    });
  }

  it("writes every inherited label", async () => {
    await seed();
    const rows = await db.$cypher<{ email: string; labels: string[] }>`
      MATCH (n:Party) RETURN n.email AS email, labels(n) AS labels ORDER BY email`;
    expect(rows.map((r) => [r.email, [...r.labels].sort()])).toEqual([
      ["b@x.io", ["Buyer", "Party", "Reachable"]],
      ["e@x.io", ["Engineer", "Party", "Reachable", "Staffer"]],
      ["t@x.io", ["Party", "Staffer", "Temp"]],
    ]);
  });

  it("queries each level of the hierarchy as a union of its implementations", async () => {
    await seed();
    const all = await db.party.findMany({ orderBy: { email: "asc" }, select: { email: true } });
    expect(all.map((p) => p.__typename)).toEqual(["Buyer", "Engineer", "Temp"]);
    const staff = await db.staffer.findMany({
      orderBy: { email: "asc" },
      include: { unit: { select: { name: true } }, manager: { select: { name: true } } },
    });
    expect(staff).toEqual([
      {
        __typename: "Engineer",
        id: expect.any(String),
        email: "e@x.io",
        name: "Eli",
        badge: "E1",
        phone: "2",
        level: 3,
        unit: { name: "core" },
        manager: { __typename: "Buyer", name: "Bea" },
      },
      {
        __typename: "Temp",
        id: expect.any(String),
        email: "t@x.io",
        name: "Tom",
        badge: null,
        agency: "acme",
        unit: { name: "core" },
        manager: null,
      },
    ]);
    const reachable = await db.reachable.findMany({
      where: { __typename: "Engineer" },
      include: { $on: { Engineer: { tasks: true } } },
    });
    expect(reachable).toMatchObject([{ __typename: "Engineer", tasks: [{ title: "t1" }] }]);
    expect(await db.staffer.findUnique({ where: { email: "b@x.io" } })).toBeNull();
    const unit = (await db.unit.findFirst({
      include: { staff: { orderBy: { email: "asc" }, select: { name: true } } },
    }))!;
    expect(unit.staff.map((s) => s.__typename)).toEqual(["Engineer", "Temp"]);
  });

  it("updates and deletes through an intermediate interface with the implementation's rules", async () => {
    await seed();
    expect(await db.staffer.updateMany({ data: { badge: "X" } })).toEqual({ count: 2 });
    expect((await db.engineer.findUniqueOrThrow({ where: { email: "e@x.io" } })).badge).toBe("X");
    // Engineer.tasks cascades.
    await db.staffer.delete({ where: { email: "e@x.io" } });
    expect(await db.task.count()).toBe(0);
    expect(await db.party.count()).toBe(2);
  });
});
