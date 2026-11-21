/**
 * Compile-time tests for interfaces (`interface Person` + `node Employee implements Person`),
 * checked by `tsc --noEmit` / `pnpm typecheck`. The bodies never run against a database.
 */
import { describe, expectTypeOf, it } from "vitest";
import type { Db } from "./__fixtures__/interfaces.gen.js";

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
});
