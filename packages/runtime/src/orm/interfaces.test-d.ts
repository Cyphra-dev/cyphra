/**
 * Compile-time tests for interfaces (`interface Person` + `node Employee implements Person`),
 * checked by `tsc --noEmit` / `pnpm typecheck`. The bodies never run against a database.
 */
import { describe, expectTypeOf, it } from "vitest";
import type { Db } from "./__fixtures__/interfaces.gen.js";
import type { Db as NestedDb } from "./__fixtures__/nested.gen.js";

declare const db: Db;

type EmployeeRow = {
  __typename: "Employee";
  id: string;
  email: string;
  name: string;
  bio: string | null;
  salary: number;
};
type CustomerRow = {
  __typename: "Customer";
  id: string;
  email: string;
  name: string;
  bio: string | null;
  tier: string;
  level: number | null;
};

describe("interface types", () => {
  it("returns a union of the implementations, discriminated by __typename", async () => {
    const people = await db.person.findMany({ where: { name: { startsWith: "A" } } });
    expectTypeOf(people).toEqualTypeOf<(EmployeeRow | CustomerRow)[]>();
    const p = people[0]!;
    if (p.__typename === "Employee") expectTypeOf(p.salary).toEqualTypeOf<number>();
    else expectTypeOf(p.tier).toEqualTypeOf<string>();
    // @ts-expect-error salary is only on Employee
    void p.salary;
  });

  it("selects interface fields only, keeping __typename", async () => {
    const rows = await db.person.findMany({ select: { name: true } });
    expectTypeOf(rows).toEqualTypeOf<
      ({ __typename: "Employee"; name: string } | { __typename: "Customer"; name: string })[]
    >();
    // @ts-expect-error salary is not an interface field
    await db.person.findMany({ select: { salary: true } });
  });

  it("includes interface relations, typed as unions when they target an interface", async () => {
    const p = await db.person.findUniqueOrThrow({
      where: { email: "a@x" },
      include: { manager: true },
    });
    expectTypeOf(p.manager).toEqualTypeOf<EmployeeRow | CustomerRow | null>();
    const e = await db.employee.findUniqueOrThrow({
      where: { email: "a@x" },
      include: { manager: true, team: true },
    });
    expectTypeOf(e.manager).toEqualTypeOf<EmployeeRow | CustomerRow | null>();
    expectTypeOf(e.team).toEqualTypeOf<{ id: string; name: string } | null>();
    // @ts-expect-error team is a relation of Employee, not of Person
    await db.person.findMany({ include: { team: true } });
  });

  it("keeps concrete results without __typename, with inherited fields", async () => {
    const e = await db.employee.create({ data: { email: "e@x", name: "E" } });
    expectTypeOf(e).toEqualTypeOf<Omit<EmployeeRow, "__typename">>();
  });

  it("has no create operations on an interface", () => {
    // @ts-expect-error interfaces cannot be created
    void db.person.create;
    // @ts-expect-error interfaces cannot be created
    void db.person.createMany;
    // @ts-expect-error interfaces cannot be created
    void db.person.upsert;
    expectTypeOf(db.person.update).toBeFunction();
    expectTypeOf(db.person.deleteMany).toBeFunction();
    expectTypeOf(db.person.search).toBeFunction();
  });

  it("connects to an interface target but does not create one", async () => {
    await db.employee.create({
      data: { email: "e@x", name: "E", manager: { connect: { email: "boss@x" } } },
    });
    await db.employee.create({
      // @ts-expect-error a nested create into an interface target is not allowed
      data: { email: "e@x", name: "E", manager: { create: { email: "b@x", name: "B" } } },
    });
    await db.employee.update({
      where: { email: "e@x" },
      data: { notes: { create: { text: "hi" } } },
    });
  });

  it("filters and sorts by __typename (implementation names only)", async () => {
    await db.person.findMany({ where: { __typename: "Employee" }, orderBy: { __typename: "asc" } });
    await db.person.findMany({ where: { __typename: { in: ["Employee", "Customer"] } } });
    await db.person.findMany({ where: { __typename: { not: "Customer" }, name: "A" } });
    await db.team.findMany({ where: { owner: { is: { __typename: "Customer" } } } });
    // @ts-expect-error Team is not an implementation of Person
    await db.person.findMany({ where: { __typename: "Team" } });
    // @ts-expect-error a node has no __typename filter
    await db.employee.findMany({ where: { __typename: "Employee" } });
    // @ts-expect-error a node does not sort by __typename
    await db.employee.findMany({ orderBy: { __typename: "asc" } });
  });

  it("narrows what $on loads to its implementation's results", async () => {
    const rows = await db.person.findMany({
      include: { manager: true, $on: { Employee: { team: true }, Customer: { notes: true } } },
    });
    const r = rows[0]!;
    expectTypeOf(r.manager).toEqualTypeOf<EmployeeRow | CustomerRow | null>();
    if (r.__typename === "Employee") {
      expectTypeOf(r.team).toEqualTypeOf<{ id: string; name: string } | null>();
      expectTypeOf(r.salary).toEqualTypeOf<number>();
    } else {
      expectTypeOf(r.notes).toEqualTypeOf<{ id: string; text: string }[]>();
      // @ts-expect-error team is only loaded on Employee results
      void r.team;
    }
    const sel = await db.person.findMany({
      select: {
        name: true,
        $on: { Employee: { salary: true, badges: { select: { name: true } } } },
      },
    });
    expectTypeOf(sel).toEqualTypeOf<
      (
        | { __typename: "Employee"; name: string; salary: number; badges: { name: string }[] }
        | { __typename: "Customer"; name: string }
      )[]
    >();
    // @ts-expect-error Team is not an implementation of Person
    await db.person.findMany({ include: { $on: { Team: {} } } });
    // @ts-expect-error include.$on takes relations only
    await db.person.findMany({ include: { $on: { Employee: { salary: true } } } });
    // @ts-expect-error $on is only on interfaces
    await db.employee.findMany({ include: { $on: {} } });
  });
});

declare const nested: NestedDb;

describe("interfaces extending interfaces", () => {
  it("returns every implementation below an interface", async () => {
    const parties = await nested.party.findMany({ select: { name: true } });
    expectTypeOf(parties.map((p) => p.__typename)).toEqualTypeOf<
      ("Engineer" | "Temp" | "Buyer")[]
    >();
    const staff = await nested.staffer.findMany({ include: { unit: true } });
    expectTypeOf(staff.map((s) => s.__typename)).toEqualTypeOf<("Engineer" | "Temp")[]>();
    const s = staff[0]!;
    expectTypeOf(s.email).toEqualTypeOf<string>();
    expectTypeOf(s.unit).toEqualTypeOf<{ id: string; name: string } | null>();
    if (s.__typename === "Temp") expectTypeOf(s.agency).toEqualTypeOf<string>();
    await nested.reachable.findMany({ where: { __typename: "Buyer", phone: { not: null } } });
    // @ts-expect-error Temp does not implement Reachable
    await nested.reachable.findMany({ where: { __typename: "Temp" } });
    // @ts-expect-error an interface extending others cannot be created either
    void nested.staffer.create;
  });

  it("gives implementations the fields of every ancestor", async () => {
    const e = await nested.engineer.create({
      data: { email: "e@x", name: "E", badge: "b", phone: "1", unit: { connect: { name: "u" } } },
    });
    expectTypeOf(e).toEqualTypeOf<{
      id: string;
      email: string;
      name: string;
      badge: string | null;
      phone: string | null;
      level: number;
    }>();
  });
});
