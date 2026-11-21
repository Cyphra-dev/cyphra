/**
 * Data written by neo4j-better-auth 0.2.1 (the driver-based adapter), migrated with
 * `neo4jBetterAuthMigration`, then read and used through `cyphraAdapter`.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { getAuthTables } from "better-auth/db";
import { initGetFieldName, initGetModelName } from "better-auth/adapters";
import { organization } from "better-auth/plugins";
import neo4j, { type Driver } from "neo4j-driver";
import { neo4jAdapter, runCypherMigration } from "neo4j-better-auth";
import type { CyphraClient } from "@cyphra/runtime";
import { cyphraAdapter, neo4jBetterAuthMigration } from "../src/index.js";
import { hasNeo4j, migrate, resetDatabase, run, testClient } from "./helpers.js";

const options = {
  secret: "test-secret-that-is-long-enough-for-better-auth-tests",
  baseURL: "http://localhost:3000",
  emailAndPassword: { enabled: true },
  plugins: [organization()],
} satisfies BetterAuthOptions;

type Row = { id: string; [key: string]: unknown };

describe.skipIf(!hasNeo4j)("migrating from neo4j-better-auth", () => {
  let driver: Driver;
  let client: CyphraClient;

  beforeAll(async () => {
    driver = neo4j.driver(
      process.env.NEO4J_TEST_URI!,
      neo4j.auth.basic(process.env.NEO4J_TEST_USER!, process.env.NEO4J_TEST_PASSWORD!),
    );
    client = testClient();
    await resetDatabase(client);
  });

  afterAll(async () => {
    await driver?.close();
    await client?.close();
  });

  it("converts labels, foreign keys and dates, and the new adapter reads the result", async () => {
    // 1. Write data with the old adapter (its own constraints, lowercase labels).
    const tables = getAuthTables(options);
    await runCypherMigration(
      async (cypher) => {
        await driver.executeQuery(cypher);
      },
      tables,
      initGetModelName({ schema: tables, usePlural: false }),
      initGetFieldName({ schema: tables, usePlural: false }),
    );
    const legacy = betterAuth({ ...options, database: neo4jAdapter({ driver }) });
    const { user, token } = await legacy.api.signUpEmail({
      body: { email: "grace@example.com", password: "correct horse battery", name: "Grace" },
    });
    const old = (await legacy.$context).adapter;
    const org = await old.create<Row>({
      model: "organization",
      data: { name: "Navy", slug: "navy", createdAt: new Date() },
    });
    await old.create({
      model: "member",
      data: { organizationId: org.id, userId: user.id, role: "owner", createdAt: new Date() },
    });
    const [before] = await run(
      client,
      "MATCH (s:session) RETURN s.userId AS userId, s.expiresAt AS expiresAt",
    );
    expect(before!.get("userId")).toBe(user.id);
    expect(typeof before!.get("expiresAt")).toBe("string");

    // 2. Migrate (twice: every statement is idempotent), then create the new constraints.
    for (let pass = 0; pass < 2; pass++) {
      for (const statement of neo4jBetterAuthMigration(options)) await run(client, statement);
    }
    await migrate(client, options);

    const [after] = await run(
      client,
      `MATCH (n) WITH collect(DISTINCT labels(n)[0]) AS labels
       RETURN labels,
              COLLECT { MATCH (s:Session) RETURN s.userId } AS sessionFk,
              COLLECT { MATCH (s:Session) RETURN valueType(s.expiresAt) } AS expiresType,
              COUNT { (:User)-[:HAS_SESSION]->(:Session) } AS sessionEdges,
              COUNT { (:Organization)-[:HAS_MEMBER]->(:Member)<-[:HAS_MEMBER]-(:User) } AS memberEdges`,
    );
    expect([...(after!.get("labels") as string[])].sort()).toEqual([
      "Account",
      "Member",
      "Organization",
      "Session",
      "User",
    ]);
    expect(after!.get("sessionFk")).toEqual([null]);
    expect(after!.get("expiresType")).toEqual(["ZONED DATETIME NOT NULL"]);
    expect(Number(after!.get("sessionEdges"))).toBe(1);
    expect(Number(after!.get("memberEdges"))).toBe(1);

    // 3. The new adapter sees the same users, sessions and memberships.
    const auth = betterAuth({ ...options, database: cyphraAdapter({ client }) });
    const ctx = await auth.$context;
    const session = await ctx.internalAdapter.findSession(token!);
    expect(session?.user.email).toBe("grace@example.com");
    expect(session?.session.userId).toBe(user.id);
    expect(session?.session.expiresAt).toBeInstanceOf(Date);
    const members = await ctx.adapter.findMany<Row>({
      model: "member",
      where: [{ field: "userId", value: user.id }],
    });
    expect(members).toMatchObject([{ organizationId: org.id, role: "owner" }]);

    // The password stored by the old adapter still signs in.
    const signedIn = await auth.api.signInEmail({
      body: { email: "grace@example.com", password: "correct horse battery" },
    });
    expect(signedIn.user.id).toBe(user.id);
  });
});
