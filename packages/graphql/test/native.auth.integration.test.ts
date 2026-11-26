/**
 * Auth of the native API against a real Neo4j: `rules` (read / create / update / delete /
 * connect / disconnect / after), `authenticated`, field rules (context-only and row-dependent),
 * `native.jwtContext` and `ctx.cyphra`. Each `@neo4j/graphql` v7 footgun the native API fixes has
 * a test in "v7 footguns" (see the "Auth" section of the native API docs).
 *
 * Needs NEO4J_TEST_URI / NEO4J_TEST_USER / NEO4J_TEST_PASSWORD; only nodes with `Na*` labels are
 * touched.
 */
import { graphql, type GraphQLSchema } from "graphql";
import { SignJWT } from "jose";
import neo4j, { type Driver } from "neo4j-driver";
import { createOrm, type OrmClient, type TypeMap } from "@cyphra/runtime";
import { parseSchema, resolveSchema } from "@cyphra/schema";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { native } from "../src/index.js";

const env = {
  uri: process.env.NEO4J_TEST_URI,
  user: process.env.NEO4J_TEST_USER,
  password: process.env.NEO4J_TEST_PASSWORD,
};
const hasNeo = Boolean(env.uri && env.user && env.password);

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const source = /* cyphra */ `
enum NaRole {
  MEMBER
  ADMIN
}

node NaUser {
  id           String    @id
  email        String    @unique
  name         String
  role         NaRole    @default(MEMBER)
  salary       Int?
  passwordHash String?
  posts        NaPost[]  @relationship(type: "NA_AUTHORED", direction: OUT)
  audits       NaAudit[] @relationship(type: "NA_AUDITED", direction: IN)
}

node NaPost {
  id        String  @id @default(cuid())
  title     String
  published Boolean @default(false)
  views     Int     @default(0)
  author    NaUser? @relationship(type: "NA_AUTHORED", direction: IN)
  tags      NaTag[] @relationship(type: "NA_TAGGED", direction: OUT)
}

node NaTag {
  name     String   @id
  internal Boolean  @default(false)
  posts    NaPost[] @relationship(type: "NA_TAGGED", direction: IN)
}

node NaAudit {
  id      String  @id
  message String
  user    NaUser? @relationship(type: "NA_AUDITED", direction: OUT)
}
`;

const seed = `CREATE (alice:NaUser {id: "u1", email: "alice@x.io", name: "Alice", role: "MEMBER", salary: 100, passwordHash: "h1"}),
  (bob:NaUser {id: "u2", email: "bob@x.io", name: "Bob", role: "MEMBER", salary: 200, passwordHash: "h2"}),
  (root:NaUser {id: "u3", email: "root@x.io", name: "Root", role: "ADMIN", salary: 300}),
  (p1:NaPost {id: "p1", title: "Hello", published: true, views: 5}),
  (p2:NaPost {id: "p2", title: "Secret draft", published: false, views: 0}),
  (p3:NaPost {id: "p3", title: "Bob's post", published: true, views: 7}),
  (p4:NaPost {id: "p4", title: "Bob draft", published: false, views: 1}),
  (alice)-[:NA_AUTHORED]->(p1), (alice)-[:NA_AUTHORED]->(p2),
  (bob)-[:NA_AUTHORED]->(p3), (bob)-[:NA_AUTHORED]->(p4),
  (db:NaTag {name: "db", internal: false}), (int:NaTag {name: "int", internal: true}),
  (p1)-[:NA_TAGGED]->(db), (p1)-[:NA_TAGGED]->(int),
  (a1:NaAudit {id: "a1", message: "login"}), (a1)-[:NA_AUDITED]->(alice)`;

type Ctx = { user?: { id: string; role: "MEMBER" | "ADMIN" } };
const me = (ctx: Ctx) => ctx.user?.id ?? "";
const isAdmin = (ctx: Ctx) => ctx.user?.role === "ADMIN";

const config = native.defineGraphQL<TypeMap, Ctx>({
  models: {
    NaUser: {
      operations: { update: ["update"] },
      fields: {
        passwordHash: false,
        // Row-dependent: each user reads their own email.
        email: { read: { where: ({ ctx }) => ({ id: me(ctx) }) } },
        // Context-only: admins read salaries.
        salary: { read: ({ ctx }) => isAdmin(ctx) },
      },
      rules: { update: ({ ctx }) => ({ id: me(ctx) }) },
    },
    NaPost: {
      operations: { create: true, update: true, delete: true },
      authenticated: { create: true, update: true, delete: true },
      rules: {
        read: ({ ctx }) => ({ OR: [{ published: true }, { author: { is: { id: me(ctx) } } }] }),
        update: ({ ctx }) => ({ author: { is: { id: me(ctx) } } }),
        delete: ({ ctx }) => (isAdmin(ctx) ? true : { author: { is: { id: me(ctx) } } }),
        after: { create: ({ ctx }) => ({ author: { is: { id: me(ctx) } } }) },
        connect: { tags: () => ({ internal: false }) },
        disconnect: { tags: () => ({ internal: false }) },
      },
    },
    NaTag: {
      operations: { create: ["create"] },
      rules: { create: ({ ctx }) => isAdmin(ctx) },
    },
    // Audit entries: never readable through the API, wherever they are reached.
    NaAudit: { rules: { read: () => false } },
  },
});

const alice: Ctx = { user: { id: "u1", role: "MEMBER" } };
const bob: Ctx = { user: { id: "u2", role: "MEMBER" } };
const admin: Ctx = { user: { id: "u3", role: "ADMIN" } };

describe.skipIf(!hasNeo)("native GraphQL API: auth (Neo4j)", () => {
  let driver: Driver;
  let db: OrmClient<TypeMap>;
  let schema: GraphQLSchema;

  const run = async (query: string, ctx: Ctx = {}, s: GraphQLSchema = schema) =>
    JSON.parse(
      JSON.stringify(await graphql({ schema: s, source: query, contextValue: { ...ctx } })),
    );
  const count = async (cypher: string) =>
    (await driver.executeQuery(cypher)).records[0]!.get(0).toNumber() as number;
  const codes = (res: { errors?: { extensions?: { code?: string } }[] }) =>
    (res.errors ?? []).map((e) => e.extensions?.code);

  beforeAll(async () => {
    driver = neo4j.driver(env.uri!, neo4j.auth.basic(env.user!, env.password!));
    db = createOrm<TypeMap>(resolveSchema(parseSchema(source)), { driver });
    schema = native.makeSchema({ client: db, config });
  });

  beforeEach(async () => {
    await driver.executeQuery(
      "MATCH (n) WHERE any(l IN labels(n) WHERE l STARTS WITH 'Na') DETACH DELETE n",
    );
    await driver.executeQuery(seed);
  });

  afterAll(async () => {
    await driver?.executeQuery(
      "MATCH (n) WHERE any(l IN labels(n) WHERE l STARTS WITH 'Na') DETACH DELETE n",
    );
    await driver?.close();
  });

  describe("v7 footguns", () => {
    it("@mutation(operations: []): a model whose writes are off has no nested create, and a create rule holds through nested writes", async () => {
      // NaAudit has no writes: NaUser's update input has no nested create for it.
      const viaSchema = await run(
        `mutation { naUserUpdate(where: { id: "u1" }, data: { audits: { create: [{ id: "a9", message: "x" }] } }) { id } }`,
        alice,
      );
      expect(viaSchema.errors[0].message).toMatch(/"create" is not defined/);
      // NaTag is creatable by admins only, also through a post's nested create.
      const nested = await run(
        `mutation { naPostCreate(data: { title: "T", author: { connect: { id: "u1" } }, tags: { create: [{ name: "new" }] } }) { id } }`,
        alice,
      );
      expect(codes(nested)).toEqual(["FORBIDDEN"]);
      expect(nested.errors[0].extensions).toMatchObject({ model: "NaTag", operation: "create" });
      expect(await count("MATCH (n:NaTag {name: 'new'}) RETURN count(n)")).toBe(0);
      expect(await count("MATCH (n:NaPost {title: 'T'}) RETURN count(n)")).toBe(0);
    });

    it("@query(read: false): a type hidden by a read rule is not readable through relations, filters, counts or connects", async () => {
      const root = await run(`{ naAuditFindMany { nodes { id } } }`, admin);
      expect(codes(root)).toEqual(["FORBIDDEN"]);
      const res = await run(
        `{ naUserFindMany(where: { id: { equals: "u1" } }) { nodes { id audits { id message } _count { audits } } } }`,
        admin,
      );
      expect(res).toEqual({
        data: { naUserFindMany: { nodes: [{ id: "u1", audits: [], _count: { audits: 0 } }] } },
      });
      const probe = await run(
        `{ naUserCount(where: { audits: { some: { message: { equals: "login" } } } }) }`,
        admin,
      );
      expect(probe.data.naUserCount).toBe(0);
      const connect = await run(
        `mutation { naUserUpdate(where: { id: "u1" }, data: { audits: { connect: [{ id: "a1" }] } }) { id } }`,
        alice,
      );
      expect(codes(connect)).toEqual(["NOT_FOUND"]);
    });

    it("hidden fields cannot be filtered or sorted on (toggles, context-only and row-dependent rules)", async () => {
      // `false`: not in the schema at all.
      const hidden = await run(
        `{ naUserFindMany(where: { passwordHash: { equals: "h1" } }) { totalCount } }`,
      );
      expect(hidden.errors[0].message).toMatch(/"passwordHash" is not defined/);
      // Context-only: a denied field is null with FORBIDDEN where selected, and cannot be used.
      const selected = await run(
        `{ naUserFindUnique(where: { id: "u1" }) { name salary } }`,
        alice,
      );
      expect(selected.data.naUserFindUnique).toEqual({ name: "Alice", salary: null });
      expect(selected.errors).toEqual([
        expect.objectContaining({
          path: ["naUserFindUnique", "salary"],
          extensions: expect.objectContaining({
            code: "FORBIDDEN",
            model: "NaUser",
            field: "salary",
          }),
        }),
      ]);
      for (const q of [
        `{ naUserCount(where: { salary: { gt: 150 } }) }`,
        `{ naUserFindMany(orderBy: [{ salary: desc }]) { totalCount } }`,
        `{ naPostFindMany(orderBy: [{ author: { salary: desc } }]) { totalCount } }`,
        `{ naPostCount(where: { author: { is: { salary: { gt: 150 } } } }) }`,
      ]) {
        expect(codes(await run(q, alice)), q).toEqual(["FORBIDDEN"]);
      }
      const asAdmin = await run(`{ naUserCount(where: { salary: { gt: 150 } }) }`, admin);
      expect(asAdmin.data.naUserCount).toBe(2);
      // Row-dependent: other users' emails are null, and filters / sorting see null too.
      const emails = await run(
        `{ naUserFindMany(orderBy: [{ id: asc }]) { nodes { id email } } }`,
        alice,
      );
      expect(emails.data.naUserFindMany.nodes).toEqual([
        { id: "u1", email: "alice@x.io" },
        { id: "u2", email: null },
        { id: "u3", email: null },
      ]);
      const probe = await run(`{ naUserCount(where: { email: { endsWith: "@x.io" } }) }`, alice);
      expect(probe.data.naUserCount).toBe(1);
      const byUnique = await run(
        `{ naUserFindUnique(where: { email: "bob@x.io" }) { id } }`,
        alice,
      );
      expect(byUnique.data.naUserFindUnique).toBeNull();
      const sorted = await run(
        `{ naUserFindMany(orderBy: [{ email: asc }]) { nodes { id } } }`,
        alice,
      );
      expect(sorted.data.naUserFindMany.nodes[0]).toEqual({ id: "u1" });
    });

    it("AGGREGATE rules: counts, totalCount and _count only see readable nodes", async () => {
      const res = await run(
        `{
          naPostCount
          naPostFindMany { totalCount nodes { id } }
          naUserFindMany(orderBy: [{ id: asc }]) { nodes { id _count { posts } } }
        }`,
        alice,
      );
      expect(res.data.naPostCount).toBe(3);
      expect(res.data.naPostFindMany.totalCount).toBe(3);
      expect(res.data.naUserFindMany.nodes).toEqual([
        { id: "u1", _count: { posts: 2 } },
        { id: "u2", _count: { posts: 1 } },
        { id: "u3", _count: { posts: 0 } },
      ]);
      const anonymous = await run(`{ naPostCount }`);
      expect(anonymous.data.naPostCount).toBe(2);
    });

    it("filters cannot probe nodes the read rules hide", async () => {
      const res = await run(
        `{ naUserFindMany(where: { posts: { some: { title: { equals: "Bob draft" } } } }) { nodes { id } } }`,
        alice,
      );
      expect(res.data.naUserFindMany.nodes).toEqual([]);
      const own = await run(
        `{ naUserFindMany(where: { posts: { some: { title: { equals: "Bob draft" } } } }) { nodes { id } } }`,
        bob,
      );
      expect(own.data.naUserFindMany.nodes).toEqual([{ id: "u2" }]);
    });

    it("relationship-only updates apply the node's update rule", async () => {
      const res = await run(
        `mutation { naPostUpdate(where: { id: "p1" }, data: { tags: { disconnect: [{ name: "db" }] } }) { id } }`,
        bob,
      );
      expect(codes(res)).toEqual(["NOT_FOUND"]);
      expect(await count("MATCH (:NaPost {id: 'p1'})-[r:NA_TAGGED]->() RETURN count(r)")).toBe(2);
      const steal = await run(
        `mutation { naUserUpdate(where: { id: "u2" }, data: { posts: { connect: [{ id: "p1" }] } }) { id } }`,
        bob,
      );
      // Connecting p1 replaces its author: an update of p1, which bob cannot update.
      expect(codes(steal)).toEqual(["NOT_FOUND"]);
      expect(
        await count(
          "MATCH (:NaUser {id: 'u1'})-[r:NA_AUTHORED]->(:NaPost {id: 'p1'}) RETURN count(r)",
        ),
      ).toBe(1);
    });

    it("mutation responses apply the read rules", async () => {
      // Root: a node written but hidden from the request is returned as null.
      const strict = native.makeSchema({
        client: db,
        config: native.defineGraphQL<TypeMap, Ctx>({
          models: {
            NaPost: {
              operations: { create: true },
              rules: { read: () => ({ published: true }) },
            },
          },
        }),
      });
      const created = await run(
        `mutation { naPostCreate(data: { title: "Hidden" }) { id title } }`,
        alice,
        strict,
      );
      expect(created).toEqual({ data: { naPostCreate: null } });
      expect(await count("MATCH (n:NaPost {title: 'Hidden'}) RETURN count(n)")).toBe(1);
      // Nested: relations of the written node only show what the request can read.
      const updated = await run(
        `mutation { naUserUpdate(where: { id: "u1" }, data: { name: "Al" }) { name audits { id } email salary } }`,
        alice,
      );
      expect(updated.data.naUserUpdate).toEqual({
        name: "Al",
        audits: [],
        email: "alice@x.io",
        salary: null,
      });
      expect(codes(updated)).toEqual(["FORBIDDEN"]);
    });
  });

  describe("rules", () => {
    it("read: anonymous requests see published posts, authors their drafts too", async () => {
      const q = `{ naPostFindMany(orderBy: [{ id: asc }]) { nodes { id } } }`;
      expect((await run(q)).data.naPostFindMany.nodes).toEqual([{ id: "p1" }, { id: "p3" }]);
      expect((await run(q, alice)).data.naPostFindMany.nodes).toEqual([
        { id: "p1" },
        { id: "p2" },
        { id: "p3" },
      ]);
    });

    it("update / delete outside the rule are NOT_FOUND; inside, they run", async () => {
      const denied = await run(
        `mutation { naPostUpdate(where: { id: "p3" }, data: { title: "Mine" }) { id } }`,
        alice,
      );
      expect(codes(denied)).toEqual(["NOT_FOUND"]);
      const own = await run(
        `mutation { naPostUpdate(where: { id: "p1" }, data: { title: "Hi" }) { title } }`,
        alice,
      );
      expect(own.data.naPostUpdate).toEqual({ title: "Hi" });
      const many = await run(`mutation { naPostUpdateMany(data: { views: 0 }) { count } }`, alice);
      expect(many.data.naPostUpdateMany.count).toBe(2);
      expect(
        codes(await run(`mutation { naPostDelete(where: { id: "p3" }) { id } }`, alice)),
      ).toEqual(["NOT_FOUND"]);
      const asAdmin = await run(`mutation { naPostDelete(where: { id: "p3" }) { id } }`, admin);
      expect(asAdmin.data.naPostDelete).toEqual({ id: "p3" });
    });

    it("after: checked once the statement's writes ran, rolled back otherwise", async () => {
      const other = await run(
        `mutation { naPostCreate(data: { title: "Forged", author: { connect: { id: "u2" } } }) { id } }`,
        alice,
      );
      expect(codes(other)).toEqual(["FORBIDDEN"]);
      expect(other.errors[0].extensions).toMatchObject({
        model: "NaPost",
        operation: "after.create",
      });
      const none = await run(`mutation { naPostCreate(data: { title: "Orphan" }) { id } }`, alice);
      expect(codes(none)).toEqual(["FORBIDDEN"]);
      expect(
        await count("MATCH (n:NaPost) WHERE n.title IN ['Forged', 'Orphan'] RETURN count(n)"),
      ).toBe(0);
      const ok = await run(
        `mutation { naPostCreate(data: { title: "Mine", author: { connect: { id: "u1" } } }) { title author { id } } }`,
        alice,
      );
      expect(ok.data.naPostCreate).toEqual({ title: "Mine", author: { id: "u1" } });
    });

    it("connect / disconnect restrict the targets", async () => {
      const internal = await run(
        `mutation { naPostUpdate(where: { id: "p1" }, data: { tags: { connect: [{ name: "int" }] } }) { id } }`,
        alice,
      );
      expect(codes(internal)).toEqual(["NOT_FOUND"]);
      const res = await run(
        `mutation { naPostUpdate(where: { id: "p1" }, data: { tags: { disconnect: [{ name: "int" }, { name: "db" }] } }) { tags(orderBy: [{ name: asc }]) { name } } }`,
        alice,
      );
      // The internal tag stays: it is outside the disconnect rule.
      expect(res.data.naPostUpdate.tags).toEqual([{ name: "int" }]);
    });

    it("authenticated: anonymous writes fail with UNAUTHENTICATED before anything runs", async () => {
      const res = await run(`mutation { naPostCreate(data: { title: "Anon" }) { id } }`);
      expect(codes(res)).toEqual(["UNAUTHENTICATED"]);
      expect(res.errors[0].extensions).toMatchObject({ model: "NaPost", operation: "create" });
    });

    it("a whole authenticated group applies wherever the model is reached", async () => {
      const guarded = native.makeSchema({
        client: db,
        config: native.defineGraphQL<TypeMap, Ctx>({
          models: { NaPost: { authenticated: { read: true } } },
        }),
      });
      expect(codes(await run(`{ naPostCount }`, {}, guarded))).toEqual(["UNAUTHENTICATED"]);
      const nested = await run(
        `{ naUserFindUnique(where: { id: "u1" }) { posts { id } _count { posts } } }`,
        {},
        guarded,
      );
      expect(nested.data.naUserFindUnique).toEqual({ posts: [], _count: { posts: 0 } });
      expect((await run(`{ naPostCount }`, alice, guarded)).data.naPostCount).toBe(4);
    });

    it("mutationTransaction request: a rule failing in one field rolls every field back", async () => {
      const perRequest = native.makeSchema({
        client: db,
        config: native.defineGraphQL<TypeMap, Ctx>({ ...config, mutationTransaction: "request" }),
      });
      const res = await run(
        `mutation {
          a: naPostUpdate(where: { id: "p1" }, data: { title: "Changed" }) { id }
          b: naPostCreate(data: { title: "Forged", author: { connect: { id: "u2" } } }) { id }
        }`,
        alice,
        perRequest,
      );
      expect(codes(res)).toEqual(["FORBIDDEN", "FORBIDDEN"]);
      expect(await count("MATCH (n:NaPost {title: 'Changed'}) RETURN count(n)")).toBe(0);
    });
  });

  describe("context", () => {
    it("ctx.cyphra is the request's client with the rules applied, $unsafe without", async () => {
      const ctx = await native.context(schema, () => ({ ...alice }))(undefined);
      const cyphra = (
        ctx as unknown as { cyphra: OrmClient<TypeMap> & { $unsafe: OrmClient<TypeMap> } }
      ).cyphra;
      expect(await cyphra.naPost.count()).toBe(3);
      expect(await cyphra.$unsafe.naPost.count()).toBe(4);
      const users = (await cyphra.naUser.findMany({
        orderBy: { id: "asc" },
        select: { email: true, salary: true },
      })) as unknown as { email: string | null; salary: number | null }[];
      expect(users.map((u) => u.email)).toEqual(["alice@x.io", null, null]);
      expect(users.every((u) => u.salary === null)).toBe(true);
      await expect(
        cyphra.naPost.create({ data: { title: "Orphan" } as never }),
      ).rejects.toMatchObject({
        name: "ForbiddenError",
      });
      // The generated root fields of the same request share it.
      const res = await graphql({ schema, source: `{ naPostCount }`, contextValue: ctx });
      expect(res.data).toEqual({ naPostCount: 3 });
    });

    it("root fields set ctx.cyphra when the context has none", async () => {
      const ctx: Record<string, unknown> = { ...bob };
      await graphql({ schema, source: `{ naPostCount }`, contextValue: ctx });
      const cyphra = ctx.cyphra as OrmClient<TypeMap>;
      expect(await cyphra.naPost.count()).toBe(3);
    });

    it("native.jwtContext verifies the bearer token and builds the user", async () => {
      const key = "native-auth-test-secret-of-32-bytes!";
      const context = native.jwtContext({
        key,
        user: (jwt) => ({ id: jwt.sub!, role: jwt.role as "MEMBER" | "ADMIN" }),
      });
      const sign = (k: string) =>
        new SignJWT({ role: "ADMIN" })
          .setProtectedHeader({ alg: "HS256" })
          .setSubject("u3")
          .setExpirationTime("1h")
          .sign(new TextEncoder().encode(k));
      const request = (token: string) =>
        new Request("http://localhost/graphql", { headers: { authorization: `Bearer ${token}` } });
      const valid = await context({ request: request(await sign(key)) });
      expect(valid.user).toEqual({ id: "u3", role: "ADMIN" });
      expect(valid.jwt?.sub).toBe("u3");
      // Node requests (`{ req }`) too.
      const node = await context({
        req: { headers: { authorization: `Bearer ${await sign(key)}` } },
      });
      expect(node.user).toEqual({ id: "u3", role: "ADMIN" });
      // A forged token leaves the request anonymous.
      const forged = await context({
        request: request(await sign("another-secret-of-32-bytes-long!!")),
      });
      expect(forged).toEqual({ token: expect.any(String) });
      expect(await context({})).toEqual({});
      const res = await graphql({
        schema,
        source: `mutation { naPostCreate(data: { title: "Anon" }) { id } }`,
        contextValue: forged,
      });
      expect(res.errors?.[0]?.extensions?.code).toBe("UNAUTHENTICATED");
      const asAdmin = await graphql({
        schema,
        source: `{ naUserCount(where: { salary: { gt: 150 } }) }`,
        contextValue: valid,
      });
      expect(asAdmin.data).toEqual({ naUserCount: 2 });
    });
  });
});
