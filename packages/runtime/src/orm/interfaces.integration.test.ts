import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createClient, type Db } from "./__fixtures__/interfaces.gen.js";
import { CyphraValidationError } from "./errors.js";
import { onMemgraph, testDdl, testDialect } from "./__fixtures__/testDialect.js";

// Each test makes many round trips to Neo4j: the default 5 s is too tight on a busy CI runner.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const hasNeo = Boolean(
  process.env.NEO4J_TEST_URI && process.env.NEO4J_TEST_USER && process.env.NEO4J_TEST_PASSWORD,
);

const LABELS = ["Person", "Archivable", "Employee", "Customer", "Team", "Note", "Badge"];

describe.skipIf(!hasNeo)("interfaces and multiple labels (Neo4j)", () => {
  let db: Db;

  beforeEach(async () => {
    db ??= createClient({
      uri: process.env.NEO4J_TEST_URI!,
      user: process.env.NEO4J_TEST_USER!,
      password: process.env.NEO4J_TEST_PASSWORD!,
      dialect: testDialect,
    });
    await db.$cypher`MATCH (n) WHERE any(l IN labels(n) WHERE l IN ${LABELS}) DETACH DELETE n`;
  });

  afterAll(async () => {
    if (!db) return;
    await db.$cypher`MATCH (n) WHERE any(l IN labels(n) WHERE l IN ${LABELS}) DETACH DELETE n`;
    if (!onMemgraph) await db.$cypher`DROP INDEX personSearch IF EXISTS`;
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
      await db.$cypher`CREATE FULLTEXT INDEX personSearch IF NOT EXISTS FOR (n:Person) ON EACH [n.name, n.bio]`;
      await db.$cypher`CALL db.awaitIndexes(60)`;
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
