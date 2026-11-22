/**
 * One graph for auth and business data: Better Auth writes through the adapter, the app reads and
 * writes the same nodes through its generated, typed Cyphra client (`fixtures/app.gen.ts`).
 */
import { afterAll, beforeAll, describe, expect, expectTypeOf, it } from "vitest";
import { betterAuth } from "better-auth";
import { applySchema, connectionFromEnv, wipeDatabase } from "@cyphra/testing";
import { cyphraAdapter } from "../src/index.js";
import { createClient, type Db } from "./fixtures/app.gen.js";
import { hasNeo4j } from "./helpers.js";

describe.skipIf(!hasNeo4j)("Better Auth + generated Cyphra client", () => {
  let db: Db;

  beforeAll(async () => {
    db = createClient(connectionFromEnv()!);
    await wipeDatabase(db, { keepMigrations: false });
    // `cyphra push` on the merged schema: one set of constraints for auth and app models.
    await applySchema(db, { schema: new URL("./fixtures/app.cyphra", import.meta.url) });
  });

  afterAll(async () => {
    await db?.$disconnect();
  });

  it("relates business nodes to Better Auth users and queries across both", async () => {
    const auth = betterAuth({
      secret: "test-secret-that-is-long-enough-for-better-auth-tests",
      baseURL: "http://localhost:3000",
      emailAndPassword: { enabled: true },
      database: cyphraAdapter({ db }),
    });
    const { user, token } = await auth.api.signUpEmail({
      body: { email: "ada@example.com", password: "correct horse battery", name: "Ada" },
    });

    await db.project.create({
      data: { title: "Analytical Engine", owner: { connect: { id: user.id } } },
    });

    const me = await db.user.findUniqueOrThrow({
      where: { email: "ada@example.com" },
      include: { projects: true, sessions: { select: { token: true } }, accounts: true },
    });
    expectTypeOf(me.name).toEqualTypeOf<string>();
    expectTypeOf(me.projects[0]!.title).toEqualTypeOf<string>();
    expectTypeOf(me.sessions).toEqualTypeOf<{ token: string }[]>();
    expect(me.emailVerified).toBe(false);
    expect(me.createdAt).toBeInstanceOf(Date);
    expect(me.projects.map((p) => p.title)).toEqual(["Analytical Engine"]);
    expect(me.sessions).toEqual([{ token }]);
    expect(me.accounts).toMatchObject([{ providerId: "credential" }]);

    // From a session token straight to the user's projects, in one query.
    const projects = await db.project.findMany({
      where: { owner: { is: { sessions: { some: { token: token! } } } } },
    });
    expect(projects.map((p) => p.title)).toEqual(["Analytical Engine"]);

    // Better Auth deletes the user and cascades to its sessions and accounts; the project stays
    // and only loses its edge.
    const ctx = await auth.$context;
    await ctx.internalAdapter.deleteUser(user.id);
    expect(await db.session.count()).toBe(0);
    expect(await db.account.count()).toBe(0);
    expect(await db.project.findMany({ include: { owner: true } })).toMatchObject([
      { title: "Analytical Engine", owner: null },
    ]);
  });
});
