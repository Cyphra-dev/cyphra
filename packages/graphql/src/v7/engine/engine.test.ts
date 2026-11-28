import { CyphraClient, CypherDateTimeText } from "@cyphra/runtime";
import { execute, parse } from "graphql";
import neo4j, { type Driver, type SessionConfig } from "neo4j-driver";
import { describe, expect, it } from "vitest";
import { fakeDriver } from "../../../test/helpers.js";
import { makeSchema } from "../index.js";
import { readTypeDefs } from "../model.js";
import { engineSchema } from "./schema.js";
import type { AuthContext } from "../auth/context.js";
import { ENGINE_OPTION } from "./index.js";
import { EngineAuthRules } from "./rules.js";
import { Fallback, TRUE, WhereTranslator, rootWhere } from "./where.js";

const typeDefs = /* GraphQL */ `
  type Movie @node(labels: ["Movie", "Film"]) {
    title: String! @alias(property: "name")
    released: Int
    tags: [String!]
    budget: BigInt
    premiere: DateTime
    actors: [Person!]! @relationship(type: "ACTED_IN", direction: IN, properties: "ActedIn")
    studio: Studio @relationship(type: "MADE", direction: IN)
    top: Person
      @cypher(statement: "MATCH (this)<-[:ACTED_IN]-(p) RETURN p LIMIT 1", columnName: "p")
    shout: String @cypher(statement: "RETURN this.name + '!' AS s", columnName: "s")
    castSize: Int
      @cypher(statement: "MATCH (this)<-[:ACTED_IN]-(p) RETURN count(p) AS c", columnName: "c")
    favorites: [Content!]! @relationship(type: "LIKES", direction: OUT)
  }
  type Person @node {
    name: String!
    born: Int
  }
  type Studio @node {
    name: String!
  }
  type Note @node @authentication(operations: [READ, CREATE]) {
    text: String
    at: DateTime @timestamp(operations: [CREATE, UPDATE])
  }
  type Book @node {
    title: String
  }
  union Content = Movie | Book
  type ActedIn @relationshipProperties {
    role: String
  }
  type Secret @node @authorization(filter: [{ where: { node: { owner: { eq: "$jwt.sub" } } } }]) {
    owner: String
  }
  type Lab
    @node
    @authorization(
      filter: [
        {
          operations: [READ]
          requireAuthentication: false
          where: { node: { state: { eq: "PUBLISHED" } } }
        }
        { requireAuthentication: false, where: { jwt: { roles: { includes: "admin" } } } }
      ]
      validate: [
        { operations: [CREATE, UPDATE, DELETE], where: { jwt: { roles: { includes: "admin" } } } }
      ]
    ) {
    state: String
    steps: [Step!]! @relationship(type: "HAS", direction: OUT)
  }
  type Step
    @node
    @authorization(
      filter: [
        { requireAuthentication: false, where: { node: { lab: { state: { eq: "PUBLISHED" } } } } }
        {
          requireAuthentication: false
          where: { node: { lab: { state: null } }, jwt: { level: { gt: 2 } } }
        }
        { where: { jwt: { email: { matches: ".*" } } } }
      ]
    ) {
    key: String
    lab: Lab @relationship(type: "HAS", direction: IN)
  }
`;

const model = readTypeDefs(typeDefs);
const schema = engineSchema(model);
const where = new WhereTranslator(model, schema);
const movie = model.node("Movie");
const tr = (w: unknown) => {
  const f = where.node(movie, w);
  return f === TRUE ? "TRUE" : rootWhere(f);
};

describe("engine schema", () => {
  it("maps @node types: labels, attributes by property, relationships to plain nodes, edge models", () => {
    const m = schema.nodes.get("Movie")!;
    expect(m.model.label).toBe("Movie");
    expect(m.model.labels).toEqual(["Movie", "Film"]);
    expect(m.fields.get("title")).toBe("name");
    expect(m.fields.has("top")).toBe(false);
    expect(m.relations.get("actors")).toBe("actors");
    // A relationship to a union stays on the compat compiler.
    expect(m.relations.has("favorites")).toBe(false);
    expect(m.model.fields.find((f) => f.name === "actors")).toMatchObject({
      kind: "relation",
      target: "Person",
      relType: "ACTED_IN",
      direction: "IN",
      edge: "Movie.actors",
    });
    expect(schema.schema.relationships).toEqual([
      expect.objectContaining({
        name: "Movie.actors",
        properties: [expect.objectContaining({ name: "role" })],
      }),
    ]);
  });
});

describe("v7 where → engine where", () => {
  it("scalar operators, eq null, and operators with null that filter nothing", () => {
    expect(tr({ title: { eq: "x" } })).toEqual({ name: { equals: "x" } });
    expect(tr({ title: { eq: null } })).toEqual({ name: { equals: null } });
    expect(tr({ title: { contains: null } })).toBeUndefined();
    expect(tr({ released: { gt: 1, lt: 3 } })).toEqual({
      AND: [{ released: { gt: 1 } }, { released: { lt: 3 } }],
    });
    expect(tr({ tags: { includes: "a" } })).toEqual({ tags: { has: "a" } });
    expect(tr({ released_GTE: 2 })).toEqual({ released: { gte: 2 } });
    expect(tr({ budget: { eq: neo4j.int("9007199254740993") } })).toEqual({
      budget: { equals: 9007199254740993n },
    });
  });

  it("AND / OR / NOT like v7: an OR with an empty member is `true`, NOT of it matches nothing", () => {
    expect(tr({ OR: [{}, { title: { eq: "x" } }] })).toBe("TRUE");
    expect(tr({ NOT: { OR: [{}] } })).toEqual({ OR: [] });
    expect(tr({ OR: [] })).toBeUndefined();
    expect(tr({ AND: [{}, { title: { eq: "x" } }] })).toEqual({ name: { equals: "x" } });
    expect(tr({ NOT: {} })).toBeUndefined();
  });

  it("relationship quantifiers: `{}` is ignored, `all` needs a related node, to-one null / {}", () => {
    expect(tr({ actors: { some: {} } })).toBeUndefined();
    expect(tr({ actors: { some: { name: { eq: "K" } } } })).toEqual({
      actors: { some: { name: { equals: "K" } } },
    });
    expect(tr({ actors: { all: { born: { gt: 1 } } } })).toEqual({
      actors: { some: {}, every: { born: { gt: 1 } } },
    });
    expect(tr({ actors: { some: { OR: [{}] } } })).toEqual({ actors: { some: {} } });
    expect(tr({ studio: null })).toEqual({ studio: null });
    expect(tr({ studio: {} })).toBeUndefined();
    expect(tr({ studio: { name: null } })).toEqual({ studio: { is: {} } });
    expect(tr({ actorsConnection: { none: { node: { name: { eq: "K" } } } } })).toEqual({
      actors: { none: { name: { equals: "K" } } },
    });
  });

  it("edge filters: the related node's `$edge` filter", () => {
    expect(tr({ actorsConnection: { some: { edge: { role: { eq: "x" } } } } })).toEqual({
      actors: { some: { $edge: { role: { equals: "x" } } } },
    });
    // An OR with a member that filters nothing (`role: null`) is `true`, like v7.
    expect(
      tr({
        actorsConnection: {
          single: {
            node: { name: { eq: "K" } },
            edge: { OR: [{ role: null }, { NOT: { role: { eq: "y" } } }] },
          },
        },
      }),
    ).toEqual({ _count: { actors: { equals: 1, where: { name: { equals: "K" } } } } });
    expect(
      tr({ actorsConnection: { none: { edge: { NOT: { role: { in: ["a", "b"] } } } } } }),
    ).toEqual({ actors: { none: { $edge: { NOT: { role: { in: ["a", "b"] } } } } } });
  });

  it("DateTime values: texts parsed by the database, like the compiler's `datetime($p)`", () => {
    const f = tr({ premiere: { gt: "2020-01-01T00:00:00.123456+02:00" } }) as {
      premiere: { gt: CypherDateTimeText };
    };
    expect(f.premiere.gt).toBeInstanceOf(CypherDateTimeText);
    expect(f.premiere.gt.text).toBe("2020-01-01T00:00:00.123456+02:00");
  });

  it("single: a `_count` of the matching related nodes equal to 1", () => {
    expect(tr({ actors: { single: { name: { eq: "K" } } } })).toEqual({
      _count: { actors: { equals: 1, where: { name: { equals: "K" } } } },
    });
    expect(tr({ actors_SINGLE: { OR: [{}] } })).toEqual({
      _count: { actors: { equals: 1, where: {} } },
    });
    expect(tr({ actorsConnection: { single: { node: { born: { gt: 1 } } } } })).toEqual({
      _count: { actors: { equals: 1, where: { born: { gt: 1 } } } },
    });
    expect(tr({ actors: { single: {} } })).toBeUndefined();
  });

  it("aggregation filters: engine `$aggregate` comparisons (distinct nodes in the connection form)", () => {
    expect(
      tr({ actorsConnection: { aggregate: { count: { nodes: { gt: 1 }, edges: { lt: 4 } } } } }),
    ).toEqual({
      AND: [
        { $aggregate: [{ relation: "actors", of: "count", distinct: true, op: "gt", value: 1 }] },
        { $aggregate: [{ relation: "actors", of: "count", distinct: false, op: "lt", value: 4 }] },
      ],
    });
    expect(tr({ actorsAggregate: { count_GT: 1 } })).toEqual({
      $aggregate: [{ relation: "actors", of: "count", op: "gt", value: 1 }],
    });
    expect(
      tr({
        actorsConnection: {
          aggregate: {
            OR: [
              { node: { name: { shortestLength: { lt: 3 } } } },
              { edge: { role: { longest: { gte: 2 } } } },
            ],
          },
        },
      }),
    ).toEqual({
      OR: [
        {
          $aggregate: [
            {
              relation: "actors",
              of: "node",
              distinct: true,
              field: "name",
              length: true,
              fn: "min",
              op: "lt",
              value: 3,
            },
          ],
        },
        {
          $aggregate: [
            {
              relation: "actors",
              of: "edge",
              distinct: false,
              field: "role",
              length: true,
              fn: "max",
              op: "gte",
              value: 2,
            },
          ],
        },
      ],
    });
    expect(tr({ actorsAggregate: { node: { born_AVERAGE_GTE: 1960 } } })).toEqual({
      $aggregate: [
        {
          relation: "actors",
          of: "node",
          distinct: false,
          field: "born",
          length: false,
          fn: "avg",
          op: "gte",
          value: 1960,
        },
      ],
    });
  });

  it("@cypher filters: engine `$cypher` filters on the statement's first row", () => {
    const f = tr({ shout: { eq: "x!" } }) as { $cypher: { expr: unknown; filter: unknown }[] };
    expect(f.$cypher).toEqual([
      expect.objectContaining({ type: "String", list: false, filter: { equals: "x!" } }),
    ]);
    // A statement that aggregates only in the `where` of a root read.
    expect(() => tr({ castSize: { gt: 1 } })).toThrow(Fallback);
    expect(where.atRoot(() => where.node(movie, { castSize: { gt: 1 } }))).toEqual({
      $cypher: [expect.objectContaining({ type: "Int", filter: { gt: 1 } })],
    });
    // A field returning one node: its first node, or none.
    expect(tr({ top: { name: { eq: "K" } } })).toEqual({
      $cypherNodes: [
        expect.objectContaining({
          model: "Person",
          quantifier: "first",
          where: { name: { equals: "K" } },
        }),
      ],
    });
    expect(tr({ top: null })).toEqual({
      $cypherNodes: [expect.objectContaining({ model: "Person", quantifier: "absent" })],
    });
    expect(tr({ top: {} })).toBeUndefined();
  });

  it("throws Fallback for what only the compat compiler handles", () => {
    for (const w of [
      { actorsConnection: { aggregate: { edge: { Other: { role: { longest: { gt: 1 } } } } } } },
      { favorites: { some: { Book: { title: { eq: "x" } } } } },
    ]) {
      expect(() => where.node(movie, w), JSON.stringify(w)).toThrow(Fallback);
    }
  });
});

describe("@authorization rules → engine filters", () => {
  const authOf = (jwt?: Record<string, unknown>): AuthContext => ({
    isAuthenticated: jwt !== undefined,
    jwt,
    claims: undefined,
    context: {},
  });
  const rules = (jwt?: Record<string, unknown>) =>
    new EngineAuthRules(new WhereTranslator(model, schema, true), authOf(jwt));
  const lab = model.node("Lab");
  const secret = model.node("Secret");

  it("evaluates requireAuthentication and JWT comparisons for the request", () => {
    expect(rules({ sub: "a" }).read(secret, [])).toEqual({ owner: { equals: "a" } });
    // Not authenticated: the rule (requireAuthentication) matches nothing.
    expect(rules().read(secret, [])).toEqual({ OR: [] });
    // A missing `$jwt.sub` matches nothing.
    expect(rules({}).read(secret, [])).toEqual({ OR: [] });
    expect(rules({ roles: ["admin"] }).read(lab, [])).toBe(TRUE);
    expect(rules({ roles: ["user"] }).read(lab, [])).toEqual({ state: { equals: "PUBLISHED" } });
    expect(rules().read(lab, [])).toEqual({ state: { equals: "PUBLISHED" } });
    // UPDATE: only the JWT rule applies.
    expect(rules().filter(lab, "UPDATE")).toEqual({ OR: [] });
  });

  it("validate rules: on the engine only when they hold for the request", () => {
    expect(() => rules({ roles: ["admin"] }).validated(lab, "CREATE", "AFTER")).not.toThrow();
    expect(() => rules({ roles: ["user"] }).validated(lab, "CREATE", "AFTER")).toThrow(Fallback);
    expect(() => rules().validated(lab, "DELETE", "BEFORE")).toThrow(Fallback);
    // A claim that is not a list (Cypher fails on `IN`) stays on the compiler.
    expect(() => rules({ roles: "admin" }).read(lab, [])).toThrow(Fallback);
  });

  it("rules mode: to-one filters, filters that filter nothing, uncertain comparisons", () => {
    const step = model.node("Step");
    // `lab: { state: null }` filters nothing in a rule (left out); MATCHES stays on the compiler.
    expect(() => rules({ level: 3, email: "a@b" }).read(step, [])).toThrow(Fallback);
    expect(rules({ level: 3 }).read(step, [])).toBe(TRUE);
    const r = new EngineAuthRules(new WhereTranslator(model, schema, true), {
      ...authOf({ level: 3 }),
      isAuthenticated: false,
    });
    expect(r.read(step, [])).toBe(TRUE);
    const anon = new EngineAuthRules(new WhereTranslator(model, schema, true), {
      ...authOf({ level: 1 }),
      isAuthenticated: false,
    });
    expect(anon.read(step, [])).toEqual({ lab: { is: { state: { equals: "PUBLISHED" } } } });
  });
});

type Run = { mode: string; cypher: string };

/** A fake driver answering engine statements (`{ row }` / `{ c }` records) and compiler ones. */
function engineDriver(answer: (cypher: string) => unknown[] = () => []) {
  return fakeDriver((cypher) => answer(cypher));
}

async function run(schema: ReturnType<typeof makeSchema>, source: string, contextValue = {}) {
  return execute({ schema, document: parse(source), contextValue });
}

describe("routing between the engine and the compat compiler", () => {
  it("serves plain reads on the engine, the rest on the compiler", async () => {
    const { driver, statements } = engineDriver();
    const s = makeSchema({ typeDefs, driver });
    await run(s, "{ movies { title released } }");
    await run(s, "{ movies { castSize } }");
    await run(s, "{ movies { favorites { __typename } } }");
    await run(s, "{ secrets { owner } }", { jwt: { sub: "a" } });
    await run(s, '{ movies(where: { actors: { single: { name: { eq: "K" } } } }) { title } }');
    await run(s, "{ movies { title } }", { cypherParams: { x: 1 } });
    // A CREATE validation that fails for the request: the engine's write, rolled back, Forbidden.
    const denied = await run(
      s,
      'mutation { createLabs(input: [{ state: "x" }]) { labs { state } } }',
      { jwt: { roles: ["user"] } },
    );
    expect(denied.errors?.map((e) => e.message)).toEqual(["Forbidden"]);
    // Engine statements bind `n`; the compiler's `this0`.
    const engine = (r: Run) => r.cypher.startsWith("MATCH (n:") || r.cypher.startsWith("UNWIND");
    expect(statements.map(engine)).toEqual([true, true, false, true, true, false, true]);
    expect(statements[3]!.cypher).toContain("WHERE n.`owner` = $p0");
  });

  it("reports how each root field ran to the internal engine probe, and turns the engine off", async () => {
    const { driver, statements } = engineDriver();
    const seen: [string, string | undefined][] = [];
    const probe = { onRootField: (f: string, r: string | undefined) => seen.push([f, r]) };
    const s = makeSchema({ typeDefs, driver, [ENGINE_OPTION]: probe } as never);
    await run(s, "{ movies { title } }");
    await run(s, "{ movies { top { name } shout } }");
    await run(s, "{ movies { castSize } }");
    await run(s, "{ movies { favorites { __typename } } }");
    expect(seen).toEqual([
      ["movies", undefined],
      ["movies", undefined],
      ["movies", undefined],
      ["movies", "Movie.favorites is not in the engine"],
    ]);
    const off = makeSchema({ typeDefs, driver, [ENGINE_OPTION]: false } as never);
    await run(off, "{ movies { title } }");
    expect(statements.at(-1)!.cypher.startsWith("MATCH (n:")).toBe(false);
  });

  it("runs engine statements with the compiler's session options and transaction metadata", async () => {
    const sessions: SessionConfig[] = [];
    const metadata: unknown[] = [];
    const tx = { run: async () => ({ records: [] }) };
    const driver = {
      session: (config: SessionConfig) => {
        sessions.push(config);
        return {
          executeRead: async <T>(fn: (t: typeof tx) => Promise<T>, c?: { metadata?: unknown }) => {
            metadata.push(c?.metadata);
            return fn(tx);
          },
          executeWrite: async <T>(fn: (t: typeof tx) => Promise<T>, c?: { metadata?: unknown }) => {
            metadata.push(c?.metadata);
            return fn(tx);
          },
          close: async () => {},
        };
      },
    } as unknown as Driver;
    const s = makeSchema({ typeDefs, driver, database: "movies" });
    await run(s, "{ people { name } }");
    await run(s, "{ people { name } }", {
      sessionConfig: { database: "other", impersonatedUser: "u" },
    });
    expect(sessions).toEqual([
      { database: "movies", defaultAccessMode: neo4j.session.READ },
      { database: "other", impersonatedUser: "u", defaultAccessMode: neo4j.session.READ },
    ]);
    expect(metadata).toEqual([{ app: "@cyphra/graphql" }, { app: "@cyphra/graphql" }]);
  });

  it("with a CyphraClient: client events report the engine operations; sessionConfig stays an error", async () => {
    const { driver } = engineDriver();
    const client = new CyphraClient({ driver });
    const events: string[] = [];
    client.on("query", (e) => events.push(`${e.model ?? ""}.${e.operation ?? ""}`));
    const s = makeSchema({ typeDefs, client });
    await run(s, "{ people { name } }");
    expect(events).toEqual(["Person.findMany"]);
    const r = await run(s, "{ people { name } }", { sessionConfig: { database: "x" } });
    expect(r.errors?.[0]?.message).toMatch(/context.sessionConfig \(database\) needs makeSchema/);
  });
});

describe("writes on the engine", () => {
  it("createPeople: createMany with the response projected in the same statement", async () => {
    const { driver, statements } = engineDriver(() => [{ c0: [{ name: "A" }, { name: "B" }] }]);
    const s = makeSchema({ typeDefs, driver });
    const r = await run(
      s,
      'mutation { createPeople(input: [{ name: "A" }, { name: "B", born: 1 }]) { info { nodesCreated relationshipsCreated } people { name } } }',
    );
    expect(r.errors).toBeUndefined();
    expect(r.data).toEqual({
      createPeople: {
        info: { nodesCreated: 2, relationshipsCreated: 0 },
        people: [{ name: "A" }, { name: "B" }],
      },
    });
    expect(statements[0]).toMatchObject({ mode: "write" });
    expect(statements[0]!.cypher).toContain("UNWIND $p0 AS row CREATE (n:`Person`) SET n = row");
  });

  it("updatePeople with set: updateMany, all counters 0; deletePeople counts nodes and relationships", async () => {
    const { driver, statements } = engineDriver((cypher) =>
      cypher.includes("DETACH DELETE") ? [{ c: 2, rels: 3 }] : [{ c: 1, nodes: [{ name: "B" }] }],
    );
    const s = makeSchema({ typeDefs, driver });
    const u = await run(
      s,
      'mutation { updatePeople(where: { name: { eq: "A" } }, update: { name: { set: "B" } }) { info { nodesCreated nodesDeleted } people { name } } }',
    );
    expect(u.data).toEqual({
      updatePeople: { info: { nodesCreated: 0, nodesDeleted: 0 }, people: [{ name: "B" }] },
    });
    expect(statements[0]!.cypher).toContain(
      "MATCH (n:`Person`) WHERE n.`name` = $p0 SET n.`name` = $p1",
    );
    const d = await run(s, "mutation { deletePeople { nodesDeleted relationshipsDeleted } }");
    expect(d.data).toEqual({ deletePeople: { nodesDeleted: 2, relationshipsDeleted: 3 } });
    expect(statements[1]!.cypher).toContain(
      "COUNT { UNWIND ns AS x MATCH (x)-[e]-() RETURN DISTINCT e } AS rels FOREACH (x IN ns | DETACH DELETE x)",
    );
  });

  it("@authentication: checked like the compiler, the engine runs authenticated requests", async () => {
    const { driver, statements } = engineDriver(() => [{ c: 0 }]);
    const s = makeSchema({ typeDefs, driver });
    const anon = await run(s, "{ notes { text } }");
    expect(anon.errors?.map((e) => e.message)).toEqual(["Unauthenticated"]);
    expect(statements).toHaveLength(0);
    await run(s, "{ notes { text } }", { jwt: { sub: "a" } });
    expect(statements[0]!.cypher.startsWith("MATCH (n:`Note`)")).toBe(true);
    // The response's READ check fails a create too (the compiler checks it while compiling).
    const created = await run(
      s,
      'mutation { createNotes(input: [{ text: "x" }]) { notes { text } } }',
    );
    expect(created.errors?.map((e) => e.message)).toEqual(["Unauthenticated"]);
    expect(statements).toHaveLength(1);
  });

  it("@timestamp: the database clock in the engine statement", async () => {
    const { driver, statements } = engineDriver(() => [{ c: 0 }]);
    const s = makeSchema({ typeDefs, driver });
    await run(s, 'mutation { createNotes(input: [{ text: "x" }]) { info { nodesCreated } } }', {
      jwt: { sub: "a" },
    });
    await run(s, "mutation { updateNotes { info { nodesCreated } } }", { jwt: { sub: "a" } });
    expect(statements.map((r) => r.cypher)).toEqual([
      expect.stringContaining("SET n = row, n.`at` = datetime()"),
      expect.stringContaining("SET n.`at` = datetime()"),
    ]);
  });

  it("keeps nested writes and arithmetic operators on the compiler", async () => {
    const { driver, statements } = engineDriver();
    const s = makeSchema({ typeDefs, driver });
    await run(
      s,
      'mutation { createMovies(input: [{ title: "x", actors: { create: [{ node: { name: "a" } }] } }]) { info { nodesCreated } } }',
    );
    await run(
      s,
      "mutation { updatePeople(update: { born: { add: 1 } }) { info { nodesCreated } } }",
    );
    await run(s, "mutation { deleteMovies(delete: { actors: [{ where: {} }] }) { nodesDeleted } }");
    expect(statements.some((r) => r.cypher.startsWith("MATCH (n:"))).toBe(false);
    expect(statements).toHaveLength(3);
  });
});
