import { describe, expect, it } from "vitest";
import type { DriverLike, TransactionLike } from "../client.js";
import type { CyphraEvent } from "../observability.js";
import { createClient } from "./__fixtures__/blog.gen.js";
import { createClient as createInterfacesClient } from "./__fixtures__/interfaces.gen.js";
import { CyphraValidationError } from "./errors.js";
import { getExtensionContext } from "./extensions.js";

type Row = Record<string, unknown>;

/** In-memory driver: every statement returns `rows(text)`; records statements and transactions. */
function fakeDriver(rows: (text: string) => Row[]) {
  const calls: string[] = [];
  let writeTransactions = 0;
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
      executeWrite: async (work) => {
        writeTransactions++;
        return work(tx);
      },
      close: async () => {},
    }),
    close: async () => {},
  };
  return { driver, calls, writeTransactions: () => writeTransactions };
}

const user = {
  id: "u1",
  email: "ada@example.com",
  name: "Ada",
  age: 36,
  tags: [],
  createdAt: null,
};

/** Answers reads with `row` (a user, or a post with its author) and creates with an element id. */
function blog(row: Row = user) {
  const fake = fakeDriver((text) => {
    if (text.startsWith("CREATE")) return [{ id: "4:x:0", row }];
    if (text.includes("count(n)")) return [{ c: 1 }];
    return [{ row }];
  });
  return { ...fake, db: createClient({ driver: fake.driver }) };
}

const fullName = {
  result: {
    user: {
      display: {
        needs: { name: true, email: true },
        compute: (u: { name: string | null; email: string }) => `${u.name} <${u.email}>`,
      },
    },
  },
};

describe("computed fields", () => {
  it("adds computed fields to results without select", async () => {
    const { db } = blog();
    const xdb = db.$extends(fullName);
    const [u] = await xdb.user.findMany();
    expect(u).toEqual({ ...user, display: "Ada <ada@example.com>" });
  });

  it("fetches needs for a selected computed field, then strips them", async () => {
    const { db, calls } = blog({ id: "u1", name: "Ada", email: "ada@example.com" });
    const xdb = db.$extends(fullName);
    const u = await xdb.user.findFirst({ select: { id: true, display: true } });
    expect(calls[0]).toContain("n{.`id`, .`name`, .`email`}");
    expect(u).toEqual({ id: "u1", display: "Ada <ada@example.com>" });
  });

  it("computes selected fields on the nodes of batch operations", async () => {
    const fake = fakeDriver((text) =>
      text.includes("DETACH DELETE")
        ? [{ c: 1, nodes: [{ id: "u1", name: "Ada", email: "ada@example.com" }] }]
        : [{ c: 1 }],
    );
    const xdb = createClient({ driver: fake.driver }).$extends(fullName);
    const res = await xdb.user.deleteMany({ select: { id: true, display: true } });
    expect(fake.calls[0]).toContain("n{.`id`, .`name`, .`email`}");
    expect(res).toEqual({ count: 1, nodes: [{ id: "u1", display: "Ada <ada@example.com>" }] });
    // Without select there are no nodes to compute on.
    expect(await xdb.user.updateMany({ data: { age: 1 } })).toEqual({ count: 1 });
  });

  it("keeps needs that are selected and leaves unselected computed fields out", async () => {
    const { db, calls } = blog({ name: "Ada" });
    const xdb = db.$extends(fullName);
    const u = await xdb.user.findFirst({ select: { name: true, display: false } });
    expect(calls[0]).toContain("n{.`name`}");
    expect(u).toEqual({ name: "Ada" });
  });

  it("applies on included and selected relations", async () => {
    const post = { id: "p1", title: "Hi", author: { ...user } };
    const { db, calls } = blog(post);
    const xdb = db.$extends(fullName).$extends({
      result: {
        post: { shout: { needs: { title: true }, compute: (p) => p.title.toUpperCase() } },
      },
    });
    const p = await xdb.post.findFirst({ include: { author: true } });
    expect(p).toMatchObject({ shout: "HI", author: { display: "Ada <ada@example.com>" } });

    calls.length = 0;
    await xdb.post.findFirst({ select: { id: true, author: { select: { display: true } } } });
    expect(calls[0]).toContain("RETURN m0{.`name`, .`email`}");
  });

  it("lets a computed field shadow a scalar and later extensions override earlier ones", async () => {
    const { db } = blog();
    const xdb = db
      .$extends({
        result: {
          user: { name: { needs: { name: true }, compute: (u) => u.name?.toUpperCase() } },
        },
      })
      .$extends({ result: { $allModels: { kind: { compute: () => "node" } } } })
      .$extends({ result: { user: { kind: { compute: () => "user" } } } });
    const u = await xdb.user.findUniqueOrThrow({ where: { id: "u1" } });
    expect(u.name).toBe("ADA");
    expect(u.kind).toBe("user");
    const p = await xdb.post.findFirst();
    expect(p?.kind).toBe("node");
    const s = await xdb.user.findFirst({ select: { name: true } });
    expect(s).toEqual({ name: "ADA" });
  });

  it("applies to create results and leaves counts and aggregates alone", async () => {
    const { db } = blog();
    const xdb = db.$extends(fullName);
    const u = await xdb.user.create({ data: { email: "ada@example.com", name: "Ada" } });
    expect(u.display).toBe("Ada <ada@example.com>");
    expect(await xdb.user.count()).toBe(1);
  });

  it("applies the interface's and the implementation's computed fields", async () => {
    const fake = fakeDriver(() => [
      {
        row: {
          __labels: ["Person", "Employee"],
          id: "e1",
          email: "e@example.com",
          name: "Eve",
          salary: 10,
        },
      },
    ]);
    const db = createInterfacesClient({ driver: fake.driver }).$extends({
      result: {
        person: { initial: { needs: { name: true }, compute: (p) => p.name.charAt(0) } },
        employee: { pay: { needs: { salary: true }, compute: (e) => e.salary * 12 } },
      },
    });
    const [p] = await db.person.findMany();
    expect(p).toMatchObject({ __typename: "Employee", initial: "E", pay: 120 });
  });

  it("computes fields selected or loaded through $on", async () => {
    const fake = fakeDriver(() => [
      {
        row: {
          __labels: ["Person", "Employee"],
          name: "Eve",
          __on_Employee: { salary: 10, team: { id: "t1", name: "core" } },
        },
      },
    ]);
    const db = createInterfacesClient({ driver: fake.driver }).$extends({
      result: {
        employee: { pay: { needs: { salary: true }, compute: (e) => e.salary * 12 } },
        team: { shout: { needs: { name: true }, compute: (t) => t.name.toUpperCase() } },
      },
    });
    const [p] = await db.person.findMany({
      select: { name: true, $on: { Employee: { pay: true, team: true } } },
    });
    // `salary` was only fetched for `pay`: stripped from the result.
    expect(p).toEqual({
      __typename: "Employee",
      name: "Eve",
      pay: 120,
      team: { id: "t1", name: "core", shout: "CORE" },
    });
    expect(fake.calls[0]).toContain("CASE WHEN n:`Employee` THEN n{.`salary`, `team`:");
  });
});

describe("query hooks", () => {
  it("can change arguments and results, per model and for all models", async () => {
    const { db, calls } = blog();
    const order: string[] = [];
    const xdb = db.$extends({
      query: {
        $allModels: {
          async $allOperations({ operation, query, args }) {
            order.push(`all.$all:${operation}`);
            return query(args);
          },
          async findMany({ model, query, args }) {
            order.push(`all.findMany:${model}`);
            return query(args);
          },
        },
        user: {
          async $allOperations({ query, args }) {
            order.push("user.$all");
            return query(args);
          },
          async findMany({ args, query }) {
            order.push("user.findMany");
            const rows = await query({ ...args, where: { ...args.where, name: "Ada" } });
            return rows.map((r) => ({ ...r, email: r.email.toUpperCase() }));
          },
        },
      },
    });
    const rows = await xdb.user.findMany();
    expect(order).toEqual(["all.$all:findMany", "all.findMany:User", "user.$all", "user.findMany"]);
    expect(calls[0]).toMatch(/WHERE n\.`name` = \$p0/);
    expect(rows[0]!.email).toBe("ADA@EXAMPLE.COM");
  });

  it("runs earlier extensions' hooks first and leaves the original client unchanged", async () => {
    const { db, calls } = blog();
    const order: string[] = [];
    const a = db.$extends({
      query: { user: { count: ({ args, query }) => (order.push("a"), query(args)) } },
    });
    const b = a.$extends({
      query: { user: { count: ({ args, query }) => (order.push("b"), query(args)) } },
    });
    await b.user.count();
    expect(order).toEqual(["a", "b"]);
    order.length = 0;
    await db.user.count();
    await a.user.count();
    expect(order).toEqual(["a"]);
    expect(calls).toHaveLength(3);
  });

  it("can answer without running the query, and sees computed fields", async () => {
    const { db, calls } = blog();
    const seen: unknown[] = [];
    const xdb = db.$extends(fullName).$extends({
      query: {
        user: {
          async findFirst({ args, query }) {
            const r = await query(args);
            seen.push(r?.display);
            return r;
          },
          async deleteMany() {
            return { count: 0 };
          },
        },
      },
    });
    await xdb.user.findFirst();
    expect(seen).toEqual(["Ada <ada@example.com>"]);
    expect(await xdb.user.deleteMany()).toEqual({ count: 0 });
    expect(calls).toHaveLength(1);
  });

  it("names the original operation in events", async () => {
    const { driver } = fakeDriver(() => [{ row: user }]);
    const events: CyphraEvent[] = [];
    const db = createClient({ driver, log: (e) => events.push(e) });
    const xdb = db.$extends({
      query: { user: { findFirst: ({ args, query }) => query({ ...args, where: { id: "u1" } }) } },
    });
    await xdb.user.findFirst();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "query", model: "User", operation: "findFirst" });
  });
});

describe("model methods and client members", () => {
  it("binds this to the extended delegate, with $name and $parent", async () => {
    const { db } = blog();
    const xdb = db.$extends(fullName).$extends({
      model: {
        user: {
          findByEmail(email: string) {
            return this.findUnique({ where: { email } });
          },
          async displayOf(email: string) {
            const ctx = getExtensionContext(this);
            return (await ctx.findByEmail(email))?.display;
          },
          parentHasPosts() {
            return typeof this.$parent.post.findMany === "function" && this.$name === "User";
          },
        },
        $allModels: {
          async exists(where: Record<string, unknown>) {
            return (await this.count({ where })) > 0;
          },
        },
      },
      client: {
        $health() {
          return this.user.count();
        },
        version: 2,
      },
    });
    expect(await xdb.user.displayOf("ada@example.com")).toBe("Ada <ada@example.com>");
    expect(xdb.user.parentHasPosts()).toBe(true);
    expect(await xdb.post.exists({ title: "Hi" })).toBe(true);
    expect(await xdb.$health()).toBe(1);
    expect(xdb.version).toBe(2);
    expect("findByEmail" in db.user).toBe(false);
  });

  it("accepts a function (reusable extension)", async () => {
    const { db } = blog();
    const withHealth = <C extends { user: { count(): Promise<number> } }>(c: C) => ({
      ...c,
      ok: () => c.user.count(),
    });
    const xdb = db.$extends(withHealth);
    expect(await xdb.ok()).toBe(1);
  });
});

describe("$transaction on an extended client", () => {
  it("applies hooks, computed fields and model methods inside the transaction", async () => {
    const { db, writeTransactions } = blog();
    const events: CyphraEvent[] = [];
    db.$on("query", (e) => events.push(e));
    const hooked: string[] = [];
    const xdb = db.$extends(fullName).$extends({
      query: { user: { findFirst: ({ args, query }) => (hooked.push("findFirst"), query(args)) } },
      model: {
        user: {
          first() {
            return this.findFirst();
          },
          parent() {
            return this.$parent;
          },
        },
      },
    });
    const out = await xdb.$transaction(async (tx) => {
      const u = await tx.user.first();
      return { display: u?.display, parentIsTx: tx.user.parent() === tx };
    });
    expect(out).toEqual({ display: "Ada <ada@example.com>", parentIsTx: true });
    expect(hooked).toEqual(["findFirst"]);
    expect(writeTransactions()).toBe(1);
    expect(events[0]).toMatchObject({ operation: "findFirst", transaction: true });
  });
});

describe("validation", () => {
  it("rejects unknown models, operations and needs", () => {
    const { db } = blog();
    const ext = (x: unknown) => () => (db.$extends as (e: unknown) => unknown)(x);
    expect(ext({ query: { nope: {} } })).toThrow(CyphraValidationError);
    expect(ext({ query: { user: { explode: () => null } } })).toThrow(/not a model operation/);
    expect(ext({ result: { user: { x: { needs: { nope: true }, compute: () => 1 } } } })).toThrow(
      /needs\.nope is not a scalar field of User/,
    );
    expect(ext({ result: { user: { posts: { compute: () => 1 } } } })).toThrow(/is a relation/);
    expect(ext({ result: { user: { x: {} } } })).toThrow(/compute/);
    expect(ext({ model: { user: { x: 1 } } })).toThrow(/must be a function/);
    expect(ext({ other: {} })).toThrow(/unknown key/);
  });
});
