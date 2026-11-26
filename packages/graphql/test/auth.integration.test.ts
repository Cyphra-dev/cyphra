/**
 * Adversarial tests of `@authentication` / `@authorization` against a real Neo4j (5.23+): requests
 * without a token, with another user's token, expired or forged tokens, and attempts to read
 * protected data through nested relationships, filters, aggregates, connections and mutation
 * responses, or to write without permission.
 *
 * Every statement's raw result is recorded (what left the database), so the tests check that
 * protected values never reach the process, not only that they are absent from the GraphQL result.
 *
 * Needs NEO4J_TEST_URI / NEO4J_TEST_USER / NEO4J_TEST_PASSWORD; only nodes with the `GqlAuth*`
 * labels used here are touched. Signing keys are generated per run.
 */
import { execute, parse, type GraphQLSchema } from "graphql";
import { SignJWT } from "jose";
import neo4j, { type Driver } from "neo4j-driver";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { compat } from "../src/index.js";

const env = {
  uri: process.env.NEO4J_TEST_URI,
  user: process.env.NEO4J_TEST_USER,
  password: process.env.NEO4J_TEST_PASSWORD,
};
const hasNeo = Boolean(env.uri && env.user && env.password);

const typeDefs = /* GraphQL */ `
  type JWT @jwt {
    roles: [String!]
  }

  type GqlAuthUser
    @node
    @authorization(
      validate: [{ operations: [UPDATE, DELETE], where: { node: { id: { eq: "$jwt.sub" } } } }]
    ) {
    id: ID!
    name: String!
    salary: Int
      @authorization(
        validate: [{ operations: [READ, AGGREGATE], where: { jwt: { roles: { includes: "hr" } } } }]
      )
    phone: String
      @authorization(filter: [{ operations: [READ], where: { node: { id: { eq: "$jwt.sub" } } } }])
    docs: [GqlAuthDoc!]! @relationship(type: "GQLAUTH_OWNS", direction: OUT)
  }

  type GqlAuthDoc
    @node
    @authorization(
      filter: [
        {
          operations: [READ, AGGREGATE, UPDATE, DELETE, CREATE_RELATIONSHIP]
          where: {
            OR: [
              { node: { public: { eq: true } } }
              { node: { owner: { some: { id: { eq: "$jwt.sub" } } } } }
            ]
          }
        }
      ]
      validate: [
        {
          operations: [CREATE, UPDATE]
          when: [AFTER]
          where: { node: { owner: { single: { id: { eq: "$jwt.sub" } } } } }
        }
        {
          operations: [DELETE_RELATIONSHIP]
          where: { node: { owner: { single: { id: { eq: "$jwt.sub" } } } } }
        }
      ]
    ) {
    id: ID!
    title: String!
    public: Boolean!
    owner: [GqlAuthUser!]! @relationship(type: "GQLAUTH_OWNS", direction: IN)
  }
`;

// Values that must never leave the database for the requests below.
const BEN_SECRET_TITLE = "BEN-SECRET-TITLE-the-longest-title-of-all";
const BEN_SALARY = 777001;
const BEN_PHONE = "PHONE-BEN-SECRET";

const SEED = `
CREATE (ann:GqlAuthUser {id: "u-ann", name: "Ann", salary: 5000, phone: "PHONE-ANN"})
CREATE (ben:GqlAuthUser {id: "u-ben", name: "Ben", salary: ${BEN_SALARY}, phone: "${BEN_PHONE}"})
CREATE (a1:GqlAuthDoc {id: "d-ann-public", title: "Ann public", public: true})
CREATE (a2:GqlAuthDoc {id: "d-ann-private", title: "Ann private", public: false})
CREATE (b1:GqlAuthDoc {id: "d-ben-public", title: "Ben public", public: true})
CREATE (b2:GqlAuthDoc {id: "d-ben-private", title: "${BEN_SECRET_TITLE}", public: false})
CREATE (ann)-[:GQLAUTH_OWNS]->(a1)
CREATE (ann)-[:GQLAUTH_OWNS]->(a2)
CREATE (ben)-[:GQLAUTH_OWNS]->(b1)
CREATE (ben)-[:GQLAUTH_OWNS]->(b2)
`;

const key = `test-key-${Math.random().toString(36).slice(2)}`;
const sign = (payload: Record<string, unknown>, k = key) =>
  new SignJWT(payload).setProtectedHeader({ alg: "HS256" }).sign(new TextEncoder().encode(k));

describe.skipIf(!hasNeo)("v7 authorization on Neo4j (adversarial)", () => {
  let driver: Driver;
  let schema: GraphQLSchema;
  /** Raw results of every statement run by the schema (what left the database). */
  let raw: string[] = [];

  const cypher = async (statement: string, params: Record<string, unknown> = {}) => {
    const session = driver.session();
    try {
      return (await session.run(statement, params)).records.map((r) => r.toObject());
    } finally {
      await session.close();
    }
  };

  /** A driver that records the records returned to `@cyphra/graphql`. */
  const spyDriver = (d: Driver): Driver => {
    type Tx = { run: (q: string, p: Record<string, unknown>) => Promise<unknown> };
    const spy = (tx: Tx): Tx => ({
      run: async (q, p) => {
        const result = (await tx.run(q, p)) as { records: { toObject(): unknown }[] };
        raw.push(JSON.stringify(result.records.map((r) => r.toObject())));
        return result;
      },
    });
    return {
      session: (config: unknown) => {
        const s = d.session(config as Parameters<Driver["session"]>[0]);
        return {
          executeRead: (fn: (tx: Tx) => unknown) => s.executeRead((tx) => fn(spy(tx)) as never),
          executeWrite: (fn: (tx: Tx) => unknown) => s.executeWrite((tx) => fn(spy(tx)) as never),
          close: () => s.close(),
        };
      },
    } as unknown as Driver;
  };

  const run = async (document: string, contextValue: Record<string, unknown> = {}) =>
    execute({ schema, document: parse(document), contextValue });
  const as = async (sub: string, roles: string[] = ["user"]) => ({
    token: `Bearer ${await sign({ sub, roles })}`,
  });
  const leaked = (...values: (string | number)[]) =>
    values.filter((v) => raw.some((r) => r.includes(String(v))));
  const docTitles = async () =>
    (await cypher("MATCH (d:GqlAuthDoc) RETURN d.title AS t ORDER BY t")).map((r) => r.t);
  const ownerships = async () =>
    (
      await cypher(
        "MATCH (u:GqlAuthUser)-[:GQLAUTH_OWNS]->(d:GqlAuthDoc) RETURN u.id + '>' + d.id AS e ORDER BY e",
      )
    ).map((r) => r.e);

  beforeAll(() => {
    driver = neo4j.driver(env.uri!, neo4j.auth.basic(env.user!, env.password!));
    schema = compat.v7.makeSchema({
      typeDefs,
      driver: spyDriver(driver),
      features: { authorization: { key } },
    });
  });
  afterAll(async () => {
    await cypher("MATCH (n) WHERE n:GqlAuthUser OR n:GqlAuthDoc DETACH DELETE n");
    await driver.close();
  });
  beforeEach(async () => {
    await cypher("MATCH (n) WHERE n:GqlAuthUser OR n:GqlAuthDoc DETACH DELETE n");
    await cypher(SEED);
    raw = [];
  });

  describe("tokens", () => {
    it("without a token: nothing (rules require authentication by default)", async () => {
      const result = await run(`{ gqlAuthDocs { id title } }`);
      expect(result).toEqual({ data: { gqlAuthDocs: [] } });
      expect(leaked(BEN_SECRET_TITLE, "Ann private", "Ann public")).toEqual([]);
    });

    it("a valid token reads its own documents, not another user's", async () => {
      const result = await run(`{ gqlAuthDocs { id } }`, await as("u-ann"));
      const ids = (result.data!.gqlAuthDocs as { id: string }[]).map((d) => d.id).sort();
      expect(ids).toEqual(["d-ann-private", "d-ann-public", "d-ben-public"]);
      expect(leaked(BEN_SECRET_TITLE)).toEqual([]);
    });

    it("expired, forged and unsigned tokens are anonymous (reads) and cannot write", async () => {
      const now = Math.floor(Date.now() / 1000);
      const tokens = [
        await sign({ sub: "u-ben", roles: ["hr"], exp: now - 10 }),
        await sign({ sub: "u-ben", roles: ["hr"] }, "attacker-key"),
        `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from('{"sub":"u-ben"}').toString("base64url")}.`,
      ];
      for (const t of tokens) {
        const read = await run(`{ gqlAuthDocs { id title } }`, { token: `Bearer ${t}` });
        expect(read).toEqual({ data: { gqlAuthDocs: [] } });
        const write = await run(
          `mutation { updateGqlAuthUsers(where: { id: { eq: "u-ben" } }, update: { name: { set: "x" } }) { gqlAuthUsers { id } } }`,
          { token: `Bearer ${t}` },
        );
        expect(write.errors?.[0]?.message).toBe("Forbidden");
      }
      expect(leaked(BEN_SECRET_TITLE, BEN_SALARY)).toEqual([]);
      expect((await cypher("MATCH (u:GqlAuthUser {id: 'u-ben'}) RETURN u.name AS n"))[0]!.n).toBe(
        "Ben",
      );
    });

    it("a decoded JWT passed in the context is trusted (like v7)", async () => {
      const result = await run(`{ gqlAuthDocs { id } }`, { jwt: { sub: "u-ben" } });
      expect((result.data!.gqlAuthDocs as unknown[]).length).toBe(3);
    });

    it("rejects a context jwt that is not an object", async () => {
      const result = await run(`{ gqlAuthDocs { id } }`, { jwt: "u-ben" });
      expect(result.errors?.[0]?.message).toMatch(/context\.jwt must be/);
      expect(raw).toEqual([]);
    });

    it("claims are parameters: an injection attempt in `sub` matches nothing and changes nothing", async () => {
      const evil = `u-ann"}) MATCH (n) DETACH DELETE n //\` $p0`;
      const ctx = { token: `Bearer ${await sign({ sub: evil, roles: [evil] })}` };
      const read = await run(`{ gqlAuthDocs { id } }`, ctx);
      expect(read.errors).toBeUndefined();
      // Authenticated, but `sub` is nobody: only public documents.
      expect((read.data!.gqlAuthDocs as unknown[]).length).toBe(2);
      const write = await run(
        `mutation { deleteGqlAuthDocs(where: { id: { eq: "d-ann-public" } }) { nodesDeleted } }`,
        ctx,
      );
      // Public, so matched by the DELETE filter; nothing else is deleted.
      expect(write.data).toEqual({ deleteGqlAuthDocs: { nodesDeleted: 1 } });
      expect((await cypher("MATCH (n:GqlAuthUser) RETURN count(n) AS c"))[0]!.c.toNumber()).toBe(2);
    });
  });

  describe("reads through other paths", () => {
    it("user filters cannot widen the authorization filter", async () => {
      const result = await run(
        `{ gqlAuthDocs(where: { OR: [{ public: { eq: true } }, { public: { eq: false } }, { title: { contains: "SECRET" } }] }) { title } }`,
        await as("u-ann"),
      );
      expect(JSON.stringify(result.data)).not.toContain("SECRET");
      expect(leaked(BEN_SECRET_TITLE)).toEqual([]);
    });

    it("nested relationships and connections apply the related type's rules", async () => {
      const result = await run(
        `{ gqlAuthUsers { id docs { title } docsConnection { totalCount edges { node { title } } } } }`,
        await as("u-ann"),
      );
      expect(result.errors).toBeUndefined();
      const ben = (
        result.data!.gqlAuthUsers as { id: string; docsConnection: { totalCount: number } }[]
      ).find((u) => u.id === "u-ben")!;
      expect(ben.docsConnection.totalCount).toBe(1);
      expect(leaked(BEN_SECRET_TITLE)).toEqual([]);
    });

    it("deeply nested paths back to protected nodes are filtered too", async () => {
      const result = await run(
        `{ gqlAuthDocs { owner { docs { title owner { docsConnection { edges { node { title } } } } } } } }`,
        await as("u-ann"),
      );
      expect(result.errors).toBeUndefined();
      expect(leaked(BEN_SECRET_TITLE)).toEqual([]);
    });

    it("aggregates only see what the AGGREGATE rules allow (root and nested)", async () => {
      const result = await run(
        `{
          gqlAuthDocsConnection { aggregate { count { nodes } node { title { longest } } } }
          gqlAuthUsers { docsConnection { aggregate { count { nodes } node { title { longest } } } } }
        }`,
        await as("u-ann"),
      );
      expect(result.errors).toBeUndefined();
      const root = result.data!.gqlAuthDocsConnection as {
        aggregate: { count: { nodes: number }; node: { title: { longest: string } } };
      };
      expect(root.aggregate.count.nodes).toBe(3);
      expect(root.aggregate.node.title.longest).not.toBe(BEN_SECRET_TITLE);
      expect(leaked(BEN_SECRET_TITLE)).toEqual([]);
    });

    it("a field with a READ validate rule fails the whole field, wherever it is selected", async () => {
      const ann = await as("u-ann");
      const attempts = [
        `{ gqlAuthUsers { id salary } }`,
        `{ gqlAuthUsers { ...F } } fragment F on GqlAuthUser { pay: salary }`,
        `{ gqlAuthDocs { owner { salary } } }`,
        `{ gqlAuthUsersConnection { edges { node { salary } } } }`,
        `{ gqlAuthDocs { ownerConnection { edges { node { salary } } } } }`,
        `{ gqlAuthUsersConnection { aggregate { node { salary { max } } } } }`,
        `{ gqlAuthUsers(limit: 1, where: { id: { eq: "u-ann" } }) { salary } }`,
      ];
      for (const document of attempts) {
        const result = await run(document, ann);
        expect(result.errors?.[0]?.message, document).toBe("Forbidden");
      }
      expect(leaked(BEN_SALARY, 5000)).toEqual([]);
      const hr = await run(`{ gqlAuthUsers { id salary } }`, await as("u-hr", ["hr"]));
      expect(hr.errors).toBeUndefined();
    });

    it("a field with a READ filter rule only shows the rows it allows", async () => {
      const result = await run(`{ gqlAuthUsers { id phone } }`, await as("u-ann"));
      expect(result.data).toEqual({ gqlAuthUsers: [{ id: "u-ann", phone: "PHONE-ANN" }] });
      expect(leaked(BEN_PHONE)).toEqual([]);
    });
  });

  describe("writes", () => {
    it("UPDATE filter: another user's private document is not matched, nothing changes", async () => {
      const result = await run(
        `mutation { updateGqlAuthDocs(where: { id: { eq: "d-ben-private" } }, update: { title: { set: "pwned" } }) { gqlAuthDocs { title } } }`,
        await as("u-ann"),
      );
      expect(result.data).toEqual({ updateGqlAuthDocs: { gqlAuthDocs: [] } });
      expect(await docTitles()).toContain(BEN_SECRET_TITLE);
      expect(leaked(BEN_SECRET_TITLE)).toEqual([]);
    });

    it("a failed AFTER check rolls back every write of the statement and returns no data", async () => {
      const before = await docTitles();
      const result = await run(
        `mutation { updateGqlAuthDocs(update: { title: { set: "renamed" } }) { gqlAuthDocs { id title } } }`,
        await as("u-ann"),
      );
      expect(result.errors?.[0]?.message).toBe("Forbidden");
      expect(result.data).toBeNull();
      expect(await docTitles()).toEqual(before);
      expect(leaked("renamed")).toEqual([]);
    });

    it("the response cannot read a protected field: Forbidden and rolled back", async () => {
      const result = await run(
        `mutation { updateGqlAuthUsers(where: { id: { eq: "u-ann" } }, update: { name: { set: "Ann2" } }) { gqlAuthUsers { name salary } } }`,
        await as("u-ann"),
      );
      expect(result.errors?.[0]?.message).toBe("Forbidden");
      expect((await cypher("MATCH (u:GqlAuthUser {id: 'u-ann'}) RETURN u.name AS n"))[0]!.n).toBe(
        "Ann",
      );
      expect(leaked(5000)).toEqual([]);
    });

    it("the response applies READ rules to nested selections", async () => {
      const result = await run(
        `mutation { updateGqlAuthUsers(where: { id: { eq: "u-ann" } }, update: { name: { set: "Ann2" } }) { gqlAuthUsers { docs { owner { docs { title } phone } } } } }`,
        await as("u-ann"),
      );
      expect(result.errors).toBeUndefined();
      expect(leaked(BEN_SECRET_TITLE, BEN_PHONE)).toEqual([]);
    });

    it("validate on another user: Forbidden, nothing written", async () => {
      const result = await run(
        `mutation { deleteGqlAuthUsers(where: { id: { eq: "u-ben" } }) { nodesDeleted } }`,
        await as("u-ann"),
      );
      expect(result.errors?.[0]?.message).toBe("Forbidden");
      expect((await cypher("MATCH (u:GqlAuthUser) RETURN count(u) AS c"))[0]!.c.toNumber()).toBe(2);
    });

    it("create AFTER rules: a document not owned by the creator is never committed", async () => {
      const ann = await as("u-ann");
      for (const input of [
        `{ id: "d-new", title: "new", public: true }`,
        `{ id: "d-new", title: "new", public: true, owner: { connect: [{ where: { node: { id: { eq: "u-ben" } } } }] } }`,
      ]) {
        const result = await run(
          `mutation { createGqlAuthDocs(input: [${input}]) { gqlAuthDocs { id } } }`,
          ann,
        );
        expect(result.errors?.[0]?.message).toBe("Forbidden");
      }
      // Through a nested create under another user (no attribute written on the user).
      const nested = await run(
        `mutation { updateGqlAuthUsers(where: { id: { eq: "u-ben" } }, update: { docs: [{ create: [{ node: { id: "d-new", title: "new", public: true } }] }] }) { info { nodesCreated } } }`,
        ann,
      );
      expect(nested.errors?.[0]?.message).toBe("Forbidden");
      expect(
        (await cypher("MATCH (d:GqlAuthDoc {id: 'd-new'}) RETURN count(d) AS c"))[0]!.c.toNumber(),
      ).toBe(0);
    });

    it("connect: the CREATE_RELATIONSHIP filter hides other users' private documents", async () => {
      const before = await ownerships();
      const result = await run(
        `mutation { updateGqlAuthUsers(where: { id: { eq: "u-ann" } }, update: { docs: [{ connect: [{ where: { node: { id: { eq: "d-ben-private" } } } }] }] }) { info { relationshipsCreated } } }`,
        await as("u-ann"),
      );
      expect(result.data).toEqual({ updateGqlAuthUsers: { info: { relationshipsCreated: 0 } } });
      expect(await ownerships()).toEqual(before);
    });

    it("disconnect: DELETE_RELATIONSHIP rules on the source, and on null when nothing matches", async () => {
      const before = await ownerships();
      const ann = await as("u-ann");
      const steal = await run(
        `mutation { updateGqlAuthDocs(where: { id: { eq: "d-ben-public" } }, update: { owner: [{ disconnect: [{ where: { node: { id: { eq: "u-ben" } } } }] }] }) { gqlAuthDocs { id } } }`,
        ann,
      );
      expect(steal.errors?.[0]?.message).toBe("Forbidden");
      const none = await run(
        `mutation { updateGqlAuthUsers(where: { id: { eq: "u-ann" } }, update: { docs: [{ disconnect: [{ where: { node: { id: { eq: "missing" } } } }] }] }) { info { relationshipsDeleted } } }`,
        ann,
      );
      expect(none.errors?.[0]?.message).toBe("Forbidden");
      expect(await ownerships()).toEqual(before);
    });

    it("nested delete applies the target's DELETE filter", async () => {
      const result = await run(
        `mutation { deleteGqlAuthUsers(where: { id: { eq: "u-ann" } }, delete: { docs: [{ where: {} }] }) { nodesDeleted } }`,
        await as("u-ann"),
      );
      expect(result.data).toEqual({ deleteGqlAuthUsers: { nodesDeleted: 3 } });
      expect(await docTitles()).toContain(BEN_SECRET_TITLE);
    });
  });

  describe("the shared engine and the compat compiler", () => {
    /** The internal `makeSchema` option that turns the engine off or reports how fields ran. */
    const ENGINE = Symbol.for("cyphra.compat.v7.engine");

    it("answer every rule-protected request alike (the engine serves those it can)", async () => {
      const engineFields: string[] = [];
      const probe = {
        onRootField: (field: string, reason: string | undefined) => {
          if (reason === undefined) engineFields.push(field);
        },
      };
      const build = (engine: unknown) =>
        compat.v7.makeSchema({
          typeDefs,
          driver,
          features: { authorization: { key } },
          [ENGINE]: engine,
        } as Parameters<typeof compat.v7.makeSchema>[0]);
      const on = build(probe);
      const off = build(false);
      const ann = await as("u-ann");
      const hr = await as("u-ben", ["hr"]);
      const requests: [string, Record<string, unknown>][] = [
        [`{ gqlAuthDocs(sort: [{ id: ASC }]) { id title } }`, {}],
        [`{ gqlAuthDocs(sort: [{ id: ASC }]) { id title owner { id phone } } }`, ann],
        [
          `{ gqlAuthUsers(sort: [{ id: ASC }]) { id phone docs(sort: [{ id: ASC }]) { id } } }`,
          ann,
        ],
        [`{ gqlAuthUsers(sort: [{ id: ASC }]) { id salary } }`, ann],
        [`{ gqlAuthUsers(sort: [{ id: ASC }]) { id salary } }`, hr],
        [
          `{ gqlAuthUsersConnection(sort: [{ id: ASC }]) { totalCount edges { node { id phone docsConnection { totalCount } } } } }`,
          ann,
        ],
        [`{ gqlAuthDocsConnection(first: 1) { totalCount pageInfo { hasNextPage } } }`, ann],
        [`{ gqlAuthDocs(where: { owner: { single: { id: { eq: "u-ben" } } } }) { id } }`, ann],
        [
          `mutation { updateGqlAuthDocs(update: { title: { set: "x" } }) { gqlAuthDocs { id title } } }`,
          ann,
        ],
        [
          `mutation { updateGqlAuthUsers(where: { id: { eq: "u-ann" } }, update: { name: { set: "A" } }) { gqlAuthUsers { id name } } }`,
          ann,
        ],
        [`mutation { deleteGqlAuthDocs(where: { public: { eq: true } }) { nodesDeleted } }`, ann],
        [`mutation { deleteGqlAuthDocs { nodesDeleted } }`, {}],
      ];
      const results = async (schema: GraphQLSchema, document: string, ctx: object) => {
        await cypher("MATCH (n) WHERE n:GqlAuthUser OR n:GqlAuthDoc DETACH DELETE n");
        await cypher(SEED);
        const result = await execute({ schema, document: parse(document), contextValue: ctx });
        const state = await cypher(
          "MATCH (n) WHERE n:GqlAuthUser OR n:GqlAuthDoc RETURN n.id AS id, n.title AS title, n.name AS name ORDER BY id",
        );
        return JSON.stringify({ result, state });
      };
      for (const [document, ctx] of requests) {
        expect(await results(on, document, ctx), document).toBe(await results(off, document, ctx));
      }
      expect(engineFields).toEqual(
        expect.arrayContaining([
          "gqlAuthDocs",
          "gqlAuthUsersConnection",
          "gqlAuthDocsConnection",
          "deleteGqlAuthDocs",
        ]),
      );
    }, 60_000);
  });
});
