import "reflect-metadata";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getCyphraToken } from "@cyphra/nestjs";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { constraintStatementsFromSchema, indexStatementsFromSchema, parseSchema } from "cyphra";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module.js";
import type { Db } from "../src/cyphra.gen.js";

const { NEO4J_TEST_URI, NEO4J_TEST_USER, NEO4J_TEST_PASSWORD } = process.env;
const hasNeo = Boolean(NEO4J_TEST_URI && NEO4J_TEST_USER && NEO4J_TEST_PASSWORD);

const schemaPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../schema.cyphra");

describe.skipIf(!hasNeo)("NestJS app (Neo4j)", () => {
  let app: INestApplication;
  let db: Db;
  let base: string;
  const wipe = () => db.$cypher`MATCH (n) WHERE n:Account OR n:Transfer DETACH DELETE n`;

  const call = async (method: string, url: string, body?: unknown) => {
    const res = await fetch(base + url, {
      method,
      headers: body ? { "content-type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  const balances = async () => {
    const { body } = await call("GET", "/accounts");
    return Object.fromEntries(
      (body as unknown as { owner: string; balance: number }[]).map((a) => [a.owner, a.balance]),
    );
  };

  beforeAll(async () => {
    // What .env holds in development: read by ConfigModule.
    process.env.NEO4J_URI = NEO4J_TEST_URI;
    process.env.NEO4J_USERNAME = NEO4J_TEST_USER;
    process.env.NEO4J_PASSWORD = NEO4J_TEST_PASSWORD;
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0, "127.0.0.1");
    base = await app.getUrl();
    db = app.get<Db>(getCyphraToken());
    // The constraints `cyphra push` (or a migration) creates: Account.owner is unique.
    const doc = parseSchema(await readFile(schemaPath, "utf8"));
    await db.$client.withSession(async (session) => {
      for (const s of [...constraintStatementsFromSchema(doc), ...indexStatementsFromSchema(doc)]) {
        await session.run(s);
      }
      await session.run("CALL db.awaitIndexes(120)");
    });
  });

  beforeEach(async () => {
    await wipe();
    expect((await call("POST", "/accounts", { owner: "alice", balance: 100 })).status).toBe(201);
    expect((await call("POST", "/accounts", { owner: "bob" })).status).toBe(201);
  });

  afterAll(async () => {
    if (!app) return;
    await wipe();
    await app.close();
  });

  it("transfers money and records the transfer, in one transaction", async () => {
    const res = await call("POST", "/accounts/transfers", { from: "alice", to: "bob", amount: 30 });
    expect(res.status).toBe(201);
    expect(res.body.amount).toBe(30);
    expect(await balances()).toEqual({ alice: 70, bob: 30 });

    const alice = await call("GET", "/accounts/alice");
    expect(alice.body.transfers).toMatchObject([
      { amount: 30, from: { owner: "alice" }, to: { owner: "bob" } },
    ]);
  });

  it("rolls back the debit, the credit and the ledger entry on insufficient funds", async () => {
    const res = await call("POST", "/accounts/transfers", {
      from: "alice",
      to: "bob",
      amount: 500,
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toBe("Insufficient funds on alice.");
    expect(await balances()).toEqual({ alice: 100, bob: 0 });
    expect(await db.transfer.count()).toBe(0);
  });

  it("rolls back when the recipient does not exist", async () => {
    const res = await call("POST", "/accounts/transfers", {
      from: "alice",
      to: "nobody",
      amount: 5,
    });
    expect(res.status).toBe(404);
    expect(await balances()).toEqual({ alice: 100, bob: 0 });
  });

  it("answers the health check", async () => {
    expect(await call("GET", "/health")).toMatchObject({
      status: 200,
      body: { status: "ok", info: { neo4j: { status: "up" } } },
    });
  });
});
