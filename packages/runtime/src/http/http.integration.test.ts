/**
 * HTTP transport against a real Neo4j (Query API, port 7474). The whole ORM suite also runs over
 * HTTP in CI (`NEO4J_TEST_URI=http://…`); this file covers what is specific to the transport:
 * every typed value through the server, explicit transactions and error codes.
 */
import { cypher } from "@cyphra/query";
import neo4j from "neo4j-driver";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { CyphraClient } from "../client.js";
import {
  CypherDate,
  CypherDateTime,
  CypherDuration,
  CypherInteger,
  CypherLocalDateTime,
  CypherLocalTime,
  CypherNode,
  CypherPath,
  CypherPoint,
  CypherRelationship,
  CypherTime,
} from "../cypher-values.js";
import { Neo4jHttpError, type HttpResult } from "./driver.js";

// Each test makes many round trips to Neo4j: the default 5 s is too tight on a busy CI runner.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const uri = process.env.NEO4J_TEST_HTTP_URI;
const user = process.env.NEO4J_TEST_USER;
const password = process.env.NEO4J_TEST_PASSWORD;

describe.skipIf(!uri || !user || !password)("HTTP transport (Neo4j Query API)", () => {
  let client: CyphraClient;
  beforeAll(() => {
    client = new CyphraClient({ uri: uri!, user: user!, password: password! });
  });
  afterAll(async () => {
    if (!client) return;
    await client.withSession((s) => s.run("MATCH (n:HttpT) DETACH DELETE n"));
    await client.close();
  });

  const echo = async (value: unknown) => {
    const res = (await client.withSession((s) =>
      client.runCompiled(s, cypher`RETURN ${value} AS v, valueType(${value}) AS t`),
    )) as unknown as HttpResult;
    return { v: res.records[0]!.get("v"), t: res.records[0]!.get("t") as string };
  };

  it.each<[string, unknown, string]>([
    ["Integer", new CypherInteger(2n ** 63n - 1n), "INTEGER NOT NULL"],
    ["bigint", -(2n ** 63n), "INTEGER NOT NULL"],
    ["Float", 1.5, "FLOAT NOT NULL"],
    ["whole Float", 3, "FLOAT NOT NULL"],
    ["String", "héllo ✓", "STRING NOT NULL"],
    ["Boolean", true, "BOOLEAN NOT NULL"],
    ["Date", new CypherDate(2024, 2, 29), "DATE NOT NULL"],
    ["LocalTime", new CypherLocalTime(23, 59, 59, 999_999_999), "LOCAL TIME NOT NULL"],
    ["Time", new CypherTime(12, 30, 0, 1, -19800), "ZONED TIME NOT NULL"],
    [
      "LocalDateTime",
      new CypherLocalDateTime(1999, 12, 31, 23, 0, 0, 5),
      "LOCAL DATETIME NOT NULL",
    ],
    ["OffsetDateTime", new CypherDateTime(2024, 1, 2, 3, 4, 5, 6, 3600), "ZONED DATETIME NOT NULL"],
    [
      "ZonedDateTime",
      new CypherDateTime(2024, 7, 1, 12, 0, 0, 0, 7200, "Europe/Paris"),
      "ZONED DATETIME NOT NULL",
    ],
    ["Duration", new CypherDuration(14n, -3n, 14706n, 700_000_000), "DURATION NOT NULL"],
    ["Point WGS-84", new CypherPoint(4326, 2.35, 48.85), "POINT NOT NULL"],
    ["Point Cartesian 3D", new CypherPoint(9157, 1, -2, 3.5), "POINT NOT NULL"],
    ["List", [new CypherInteger(1), "a", null], "LIST<ANY NOT NULL>"],
    ["Map", { a: new CypherInteger(1), b: { c: new CypherDate(2024, 1, 1) } }, "MAP NOT NULL"],
  ])("round-trips %s through the server", async (_, value, type) => {
    const { v, t } = await echo(value);
    if (type.startsWith("LIST")) expect(t.startsWith("LIST")).toBe(true);
    else expect(t).toBe(type);
    const expected = typeof value === "bigint" ? new CypherInteger(value) : value;
    expect(v).toEqual(expected);
  });

  it("round-trips bytes and neo4j-driver values", async () => {
    const bytes = await echo(new Int8Array([1, -2, 127]));
    // (`valueType()` reports a byte array as a list of integers.)
    expect(bytes.v).toBeInstanceOf(Int8Array);
    expect(Array.from(bytes.v as Int8Array)).toEqual([1, -2, 127]);
    const dt = await echo(new neo4j.types.DateTime(2024, 1, 2, 3, 4, 5, 0, 0));
    expect(dt.v).toEqual(new CypherDateTime(2024, 1, 2, 3, 4, 5, 0, 0));
    expect((await echo(neo4j.int(7))).v).toEqual(new CypherInteger(7));
  });

  it("decodes nodes, relationships and paths", async () => {
    const res = (await client.withSession((s) =>
      s.run(
        "CREATE p = (a:HttpT {name: 'a'})-[r:HTTP_R {w: 2}]->(b:HttpT {name: 'b'}) RETURN a, r, p",
      ),
    )) as unknown as HttpResult;
    const rec = res.records[0]!;
    const a = rec.get("a") as CypherNode;
    const r = rec.get("r") as CypherRelationship;
    const p = rec.get("p") as CypherPath;
    expect(a).toBeInstanceOf(CypherNode);
    expect(a.labels).toEqual(["HttpT"]);
    expect(a.properties).toEqual({ name: "a" });
    expect(r.type).toBe("HTTP_R");
    expect(r.startNodeElementId).toBe(a.elementId);
    expect(r.properties).toEqual({ w: new CypherInteger(2) });
    expect(p.length).toBe(1);
    expect(p.end.properties).toEqual({ name: "b" });
  });

  it("commits explicit transactions and rolls them back on error", async () => {
    await client.withWriteTransaction(async (tx) => {
      await tx.run("CREATE (:HttpT {k: 'committed'})");
      await tx.run("CREATE (:HttpT {k: 'committed-2'})");
    });
    await expect(
      client.withWriteTransaction(async (tx) => {
        await tx.run("CREATE (:HttpT {k: 'rolled-back'})");
        throw new Error("abort");
      }),
    ).rejects.toThrow("abort");
    await expect(
      client.withWriteTransaction(async (tx) => {
        await tx.run("CREATE (:HttpT {k: 'failed'})");
        await tx.run("RETURN 1/0");
      }),
    ).rejects.toMatchObject({ code: "Neo.ClientError.Statement.ArithmeticError" });
    const rows = await client.withReadTransaction(async (tx) => {
      const r = (await tx.run(
        "MATCH (n:HttpT) WHERE n.k IS NOT NULL RETURN n.k AS k ORDER BY k",
      )) as unknown as HttpResult;
      return r.records.map((x) => x.get("k"));
    });
    expect(rows).toEqual(["committed", "committed-2"]);
  });

  it("rejects writes in read transactions", async () => {
    await expect(
      client.withReadTransaction((tx) => tx.run("CREATE (:HttpT)")),
    ).rejects.toMatchObject({ code: "Neo.ClientError.Statement.AccessMode" });
  });

  it("maps errors to Neo4jHttpError with the Neo4j code", async () => {
    const syntax = await client.withSession((s) => s.run("RETRN 1")).catch((e: unknown) => e);
    expect(syntax).toBeInstanceOf(Neo4jHttpError);
    expect((syntax as Neo4jHttpError).code).toBe("Neo.ClientError.Statement.SyntaxError");

    const bad = new CyphraClient({ uri: uri!, user: user!, password: "wrong-password" });
    await expect(bad.withSession((s) => s.run("RETURN 1"))).rejects.toMatchObject({
      code: "Neo.ClientError.Security.Unauthorized",
      status: 401,
    });

    const missing = new CyphraClient({
      uri: uri!,
      user: user!,
      password: password!,
      database: "nope",
    });
    await expect(missing.withSession((s) => s.run("RETURN 1"))).rejects.toMatchObject({
      code: "Neo.ClientError.Database.DatabaseNotFound",
    });
  });
});
