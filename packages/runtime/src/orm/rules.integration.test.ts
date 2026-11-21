import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createClient, type Db } from "./__fixtures__/rules.gen.js";
import { CyphraValidationError } from "./errors.js";

// Each test makes many round trips to Neo4j: the default 5 s is too tight on a busy CI runner.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const hasNeo = Boolean(
  process.env.NEO4J_TEST_URI && process.env.NEO4J_TEST_USER && process.env.NEO4J_TEST_PASSWORD,
);

const LABELS = ["VrUser", "VrPost"];

async function rejection(p: Promise<unknown>): Promise<CyphraValidationError> {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(CyphraValidationError);
  return err as CyphraValidationError;
}

const paths = (e: CyphraValidationError) => e.issues.map((i) => `${i.path.join(".")} ${i.rule}`);

describe.skipIf(!hasNeo)("validation rules (Neo4j)", () => {
  let db: Db;

  beforeEach(async () => {
    db ??= createClient({
      uri: process.env.NEO4J_TEST_URI!,
      user: process.env.NEO4J_TEST_USER!,
      password: process.env.NEO4J_TEST_PASSWORD!,
    });
    await db.$cypher`MATCH (n) WHERE any(l IN labels(n) WHERE l IN ${LABELS}) DETACH DELETE n`;
  });

  afterAll(async () => {
    await db?.$disconnect();
  });

  const count = async () =>
    (
      await db.$cypher<{
        c: number;
      }>`MATCH (n) WHERE any(l IN labels(n) WHERE l IN ${LABELS}) RETURN count(n) AS c`
    )[0]!.c;

  it("writes nothing when a nested create breaks a rule, and reports its path", async () => {
    const err = await rejection(
      db.vrUser.create({
        data: {
          email: "ada@example.com",
          name: "Ada",
          posts: {
            create: [
              { title: "First post", labels: ["a"] },
              { title: "x", labels: [], $edge: { role: "reviewer" } },
            ],
          },
        },
      }),
    );
    expect(paths(err)).toEqual([
      "data.posts.create.1.title length",
      "data.posts.create.1.labels nonEmpty",
      "data.posts.create.1.$edge.role length",
    ]);
    expect(await count()).toBe(0);

    const ok = await db.vrUser.create({
      data: {
        email: "ada@example.com",
        name: "Ada",
        posts: { create: [{ title: "First post", labels: ["a"], $edge: { role: "owner" } }] },
      },
      include: { posts: true },
    });
    expect(ok.posts).toHaveLength(1);
  });

  it("rejects createMany and upsert before writing", async () => {
    const err = await rejection(
      db.vrUser.createMany({
        data: [
          { email: "a@example.org", name: "Al" },
          { email: "b@example", name: "Bo" },
        ],
      }),
    );
    expect(paths(err)).toEqual(["data.1.email email"]);
    await rejection(
      db.vrUser.upsert({
        where: { email: "c@example.org" },
        create: { email: "c@example.org", name: "C" },
        update: {},
      }),
    );
    expect(await count()).toBe(0);
  });

  it("keeps the node unchanged when an operator would leave the range", async () => {
    await db.vrUser.create({ data: { email: "ada@example.com", name: "Ada", score: 60, age: 20 } });
    const where = { email: "ada@example.com" };

    const err = await rejection(
      db.vrUser.update({ where, data: { score: { increment: 10, multiply: 2 }, name: "Ada L" } }),
    );
    expect(err.issues).toEqual([
      {
        path: ["data", "score"],
        model: "VrUser",
        field: "score",
        rule: "max",
        message: "must be at most 100 (the update would make it larger).",
      },
    ]);
    expect(await db.vrUser.findUnique({ where })).toMatchObject({ score: 60, name: "Ada" });

    expect(await db.vrUser.update({ where, data: { score: { decrement: 60 } } })).toMatchObject({
      score: 0,
    });

    const upsertErr = await rejection(
      db.vrUser.upsert({
        where,
        create: { email: "ada@example.com", name: "Ada" },
        update: { age: { increment: 200 }, name: "Changed" },
      }),
    );
    expect(paths(upsertErr)).toEqual(["update.age max"]);
    expect(await db.vrUser.findUnique({ where })).toMatchObject({ age: 20, name: "Ada" });
    expect(
      await db.vrUser.upsert({
        where,
        create: { email: "ada@example.com", name: "Xavier" },
        update: { age: { increment: 1 } },
      }),
    ).toMatchObject({ age: 21 });
  });

  it("updates no node of updateMany when one would break @min", async () => {
    await db.vrUser.createMany({
      data: [
        { email: "a@example.org", name: "Al", balance: 10n },
        { email: "b@example.org", name: "Bo", balance: 3n },
      ],
    });
    const err = await rejection(db.vrUser.updateMany({ data: { balance: { decrement: 5n } } }));
    expect(paths(err)).toEqual(["data.balance min"]);
    const rows = await db.vrUser.findMany({ orderBy: { email: "asc" }, select: { balance: true } });
    expect(rows).toEqual([{ balance: 10n }, { balance: 3n }]);
    expect(await db.vrUser.updateMany({ data: { balance: { decrement: 3n } } })).toEqual({
      count: 2,
    });
  });

  it("runs nothing inside a transaction either", async () => {
    await expect(
      db.$transaction(async (tx) => {
        await tx.vrUser.create({ data: { email: "ok@example.org", name: "Ok" } });
        await tx.vrUser.create({ data: { email: "ko@example.org", name: "K" } });
      }),
    ).rejects.toBeInstanceOf(CyphraValidationError);
    expect(await count()).toBe(0);
  });
});
