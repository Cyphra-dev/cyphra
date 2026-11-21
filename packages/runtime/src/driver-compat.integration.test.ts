/**
 * `neo4j-driver` 5.x / 6.x compatibility: a `Driver` created by the application, from either major,
 * passed to Cyphra. The `neo4j-driver` that Cyphra itself resolves is whatever the workspace
 * installs (5.x by default, 6.x in the CI matrix leg that overrides it), so each run covers both
 * the same-major and the cross-major (two copies of the driver) cases.
 */
import { createRequire } from "node:module";
import type { ResolvedScalarField } from "@cyphra/schema";
import { cypher } from "@cyphra/query";
import neo4j5 from "neo4j-driver-5";
import neo4j6 from "neo4j-driver-6";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CyphraClient, type DriverLike } from "./client.js";
import { createClient, type Db } from "./orm/__fixtures__/compat.gen.js";
import { decodeScalar, encodeScalar } from "./orm/values.js";

const hasNeo = Boolean(
  process.env.NEO4J_TEST_URI && process.env.NEO4J_TEST_USER && process.env.NEO4J_TEST_PASSWORD,
);

const require = createRequire(import.meta.url);
const bundledVersion = (require("neo4j-driver/package.json") as { version: string }).version;

type DriverModule = {
  driver(uri: string, auth: unknown): DriverLike & { verifyConnectivity(): Promise<unknown> };
  auth: { basic(user: string, password: string): unknown };
  int(v: number | string): unknown;
  isInt(v: unknown): boolean;
  isDateTime(v: unknown): boolean;
  types: { DateTime: new (...args: number[]) => unknown };
};

const majors: [string, DriverModule][] = [
  ["5", neo4j5 as unknown as DriverModule],
  ["6", neo4j6 as unknown as DriverModule],
];

function field(type: ResolvedScalarField["type"]): ResolvedScalarField {
  return {
    kind: "scalar",
    name: "f",
    type,
    optional: false,
    list: false,
    id: false,
    unique: false,
    index: false,
  };
}

describe("neo4j-driver majors", () => {
  it("installs the expected driver versions", () => {
    expect(bundledVersion).toMatch(/^[56]\./);
    expect((require("neo4j-driver-5/package.json") as { version: string }).version).toMatch(/^5\./);
    expect((require("neo4j-driver-6/package.json") as { version: string }).version).toMatch(/^6\./);
  });

  it("accepts a Driver from either major at the type level", () => {
    // Compile-time check (tsc): both majors' `Driver` classes satisfy `DriverLike`.
    const drivers: DriverLike[] = [
      neo4j5.driver("bolt://127.0.0.1:1"),
      neo4j6.driver("bolt://127.0.0.1:1"),
    ];
    return Promise.all(drivers.map((d) => d.close()));
  });
});

describe.skipIf(!hasNeo).each(majors)(
  `user-supplied neo4j-driver %s Driver (Cyphra resolves neo4j-driver ${bundledVersion})`,
  (_major, mod) => {
    let driver: ReturnType<DriverModule["driver"]>;
    let db: Db;

    beforeAll(() => {
      driver = mod.driver(
        process.env.NEO4J_TEST_URI!,
        mod.auth.basic(process.env.NEO4J_TEST_USER!, process.env.NEO4J_TEST_PASSWORD!),
      );
      db = createClient({ driver });
    });

    beforeEach(async () => {
      await db.$cypher`MATCH (n) WHERE n:CompatUser OR n:CompatPost DETACH DELETE n`;
    });

    afterAll(async () => {
      if (db) {
        await db.$cypher`MATCH (n) WHERE n:CompatUser OR n:CompatPost DETACH DELETE n`;
        await db.$disconnect();
      }
      await driver?.close();
    });

    it("runs typed ORM queries with integer and DateTime round-trips", async () => {
      const createdAt = new Date("2024-02-29T23:59:58.123Z");
      const birthday = new Date("1990-12-31T00:00:00.000Z");
      const u = await db.compatUser.create({
        data: { email: "a@x.io", age: Number.MAX_SAFE_INTEGER, birthday, createdAt },
      });
      expect(u.age).toBe(Number.MAX_SAFE_INTEGER);
      expect(u.birthday).toEqual(birthday);
      expect(u.createdAt).toEqual(createdAt);

      const [types] = await db.$cypher<Record<string, string>>`
        MATCH (u:CompatUser {email: ${"a@x.io"}})
        RETURN valueType(u.birthday) AS birthday, valueType(u.createdAt) AS createdAt`;
      expect(types).toEqual({
        birthday: "DATE NOT NULL",
        createdAt: "ZONED DATETIME NOT NULL",
      });

      const [row] = await db.$cypher<{ t: string; age: number }>`
        MATCH (u:CompatUser {email: ${"a@x.io"}}) RETURN valueType(u.age) AS t, u.age AS age`;
      expect(row).toEqual({ t: "INTEGER NOT NULL", age: Number.MAX_SAFE_INTEGER });

      const found = await db.compatUser.findMany({
        where: {
          age: { gte: 1 },
          birthday: { equals: birthday },
          createdAt: { lte: new Date("2024-03-01T00:00:00Z") },
        },
      });
      expect(found).toEqual([u]);
    });

    it("round-trips BigInt at the 64-bit bounds", async () => {
      const max = 2n ** 63n - 1n;
      const min = -(2n ** 63n);
      await db.compatUser.create({ data: { email: "max@x.io", balance: max } });
      await db.compatUser.create({ data: { email: "min@x.io", balance: min } });
      const rows = await db.compatUser.findMany({
        where: { balance: { in: [min, max] } },
        orderBy: { balance: "asc" },
        select: { email: true, balance: true },
      });
      expect(rows).toEqual([
        { email: "min@x.io", balance: min },
        { email: "max@x.io", balance: max },
      ]);
      const [row] = await db.$cypher<{ t: string; s: string }>`
        MATCH (u:CompatUser {email: ${"max@x.io"}})
        RETURN valueType(u.balance) AS t, toString(u.balance) AS s`;
      expect(row).toEqual({ t: "INTEGER NOT NULL", s: max.toString() });
    });

    it("commits and rolls back $transaction", async () => {
      await db.$transaction(async (tx) => {
        const author = await tx.compatUser.create({ data: { email: "t@x.io" } });
        await tx.compatPost.create({
          data: { title: "In tx", views: 3, author: { connect: { id: author.id } } },
        });
      });
      const post = await db.compatPost.findFirst({
        where: { title: "In tx" },
        include: { author: true },
      });
      expect(post?.views).toBe(3);
      expect(post?.author?.email).toBe("t@x.io");

      await expect(
        db.$transaction(async (tx) => {
          await tx.compatUser.create({ data: { email: "rolled-back@x.io" } });
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
      expect(await db.compatUser.findUnique({ where: { email: "rolled-back@x.io" } })).toBeNull();
    });

    it("decodes the user driver's integers and temporals", async () => {
      const [row] = await db.$cypher<Record<string, unknown>>`
        RETURN ${mod.int(41)} + 1 AS i,
               ${new mod.types.DateTime(2024, 1, 2, 3, 4, 5, 6_000_000, 0)} AS dt,
               date("2024-01-02") AS d,
               localdatetime("2024-01-02T03:04:05") AS ldt`;
      expect(row!.i).toBe(42);
      expect(row!.dt).toEqual(new Date("2024-01-02T03:04:05.006Z"));
      expect(row!.d).toEqual(new Date("2024-01-02T00:00:00.000Z"));
      expect(row!.ldt).toBeInstanceOf(Date);

      await expect(db.$cypher`RETURN 9007199254740993 AS big`).rejects.toThrow(RangeError);
    });

    it("sends values encoded by Cyphra's driver through the user's driver", async () => {
      const client = new CyphraClient({ driver });
      const params = {
        i: encodeScalar(field("Int"), 7, "T"),
        big: encodeScalar(field("Int"), 2n ** 60n, "T"),
        dt: encodeScalar(field("DateTime"), new Date("2024-05-06T07:08:09.010Z"), "T"),
        d: encodeScalar(field("Date"), new Date("2024-05-06T00:00:00Z"), "T"),
      };
      const rows = await client.withReadTransaction((tx) =>
        client.queryRecordsTx(
          tx,
          cypher`RETURN valueType(${params.i}) AS ti, toString(${params.big}) AS big,
                        toString(${params.dt}) AS dt, toString(${params.d}) AS d`,
        ),
      );
      expect(rows).toEqual([
        {
          ti: "INTEGER NOT NULL",
          big: (2n ** 60n).toString(),
          dt: "2024-05-06T07:08:09.01Z",
          d: "2024-05-06",
        },
      ]);
      const [rec] = await client.withSession(async (session) => {
        const r = await client.runCompiled(session, cypher`RETURN datetime() AS now`);
        return r.records;
      });
      expect(mod.isDateTime(rec!.get("now"))).toBe(true);
    });

    it("round-trips points and temporal values between Cyphra's driver and the user's", async () => {
      const client = new CyphraClient({ driver });
      const params = {
        p: encodeScalar(field("Point"), { longitude: 2.35, latitude: 48.85, height: 30 }, "T"),
        c: encodeScalar(field("CartesianPoint"), { x: 1, y: 2 }, "T"),
        ldt: encodeScalar(field("LocalDateTime"), "2024-05-06T07:08:09.5", "T"),
        lt: encodeScalar(field("LocalTime"), "07:08", "T"),
        t: encodeScalar(field("Time"), "07:08:09-05:00", "T"),
        d: encodeScalar(field("Duration"), "P1Y2M3DT4H5M6.5S", "T"),
      };
      const [row] = await client.withReadTransaction((tx) =>
        client.queryRecordsTx(
          tx,
          cypher`RETURN valueType(${params.p}) AS tp, toString(${params.p}.srid) AS srid,
                        toString(${params.ldt}) AS ldt, toString(${params.lt}) AS lt,
                        toString(${params.t}) AS t, toString(${params.d}) AS d,
                        ${params.c}.x AS x`,
        ),
      );
      expect(row).toEqual({
        tp: "POINT NOT NULL",
        srid: "4979",
        ldt: "2024-05-06T07:08:09.5",
        lt: "07:08:00",
        t: "07:08:09-05:00",
        d: "P1Y2M3DT4H5M6.5S",
        x: 1,
      });
      // Values the user's driver returns decode the same way.
      const raw = await client.withSession(async (session) => {
        const r = await client.runCompiled(
          session,
          cypher`RETURN point({longitude: 1, latitude: 2}) AS p, localtime("10:00") AS lt,
                        time("10:00+01:00") AS t, duration("PT90M") AS d,
                        localdatetime("2024-01-02T03:04") AS ldt`,
        );
        return r.records[0]!;
      });
      expect(decodeScalar(field("Point"), raw.get("p"))).toEqual({ longitude: 1, latitude: 2 });
      expect(decodeScalar(field("LocalTime"), raw.get("lt"))).toBe("10:00:00");
      expect(decodeScalar(field("Time"), raw.get("t"))).toBe("10:00:00+01:00");
      expect(decodeScalar(field("Duration"), raw.get("d"))).toBe("PT1H30M");
      expect(decodeScalar(field("LocalDateTime"), raw.get("ldt"))).toBe("2024-01-02T03:04:00");
    });

    it("leaves a supplied driver open on close/$disconnect", async () => {
      const client = new CyphraClient({ driver });
      await client.close();
      const other = createClient({ driver });
      await other.$disconnect();
      await expect(driver.verifyConnectivity()).resolves.not.toThrow();
    });
  },
);
