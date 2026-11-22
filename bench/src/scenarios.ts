/**
 * The scenarios. Each one is written once per API style: hand-written Cypher (run by the raw
 * driver over Bolt, or by `fetch` against the Query API), the Cyphra typed client (over Bolt or
 * HTTP), neogma, and GraphQL (the same operation for @neo4j/graphql and @cyphra/graphql). Every
 * contender walks the same inputs in the same order, and the first result of each is checked
 * against the baseline's (`summarize`) before anything is timed.
 */
import { randomUUID } from "node:crypto";
import neogmaModule from "neogma";
import type { GqlExec, NeogmaModels } from "./contenders.js";
import type { Db } from "./cyphra.gen.js";
import { int, type Row, type Runner } from "./raw.js";
import type { Fixtures } from "./seed.js";

// neogma is CommonJS (see contenders.ts).
const { Op } = neogmaModule;

export type Task = {
  /** The measured call. */
  fn: () => Promise<unknown>;
  /** Unmeasured preparation before each call (e.g. the node a delete removes). */
  beforeEach?: () => Promise<void>;
  /** A small value compared across contenders on the first call (same data, same answer). */
  summarize?: (result: unknown) => unknown;
  /** Unmeasured check after the first call. */
  verify?: () => Promise<void>;
};

export type Env = {
  fx: Fixtures;
  /** Unique per scenario and contender: written nodes use it, cleanup deletes by it. */
  prefix: string;
  /** Raw Bolt runner for unmeasured setup and checks. */
  setup: Runner;
};

type Factory<T> = (api: T, env: Env) => Task;

export type Scenario = {
  id: string;
  title: string;
  description: string;
  group: "read" | "write" | "graph";
  /** Writes nodes keyed by `env.prefix` (deleted after each contender). */
  writes?: boolean;
  raw: Factory<Runner>;
  cyphra?: Factory<Db>;
  neogma?: Factory<NeogmaModels>;
  graphql?: Factory<GqlExec>;
  /** Why a contender has no implementation. */
  na?: Partial<Record<"neogma" | "graphql", string>>;
};

const cycle = <T>(items: readonly T[]) => {
  let i = 0;
  return () => items[i++ % items.length]!;
};

const USER = "u {.id, .email, .name, .age, .createdAt}";
const GQL_USER = "id email name age createdAt";

/** Cleanup of everything a write scenario created (users by email prefix, their posts, comments). */
export const CLEANUP = `
  MATCH (u:User) WHERE u.email STARTS WITH $prefix
  OPTIONAL MATCH (u)-[:AUTHORED]->(p:Post)
  OPTIONAL MATCH (p)-[:HAS_COMMENT]->(c:Comment)
  DETACH DELETE c, p, u`;

const len = (r: unknown) => (r as unknown[]).length;
const first = <T = Row>(rows: unknown) => (rows as Row[])[0] as T;

const POSTS_PER_NESTED_CREATE = 5;
const newPosts = (n: number) =>
  Array.from({ length: POSTS_PER_NESTED_CREATE }, (_, k) => ({
    title: `Nested post ${n}.${k}`,
    views: k * 10,
    published: k % 2 === 0,
  }));

export const SCENARIOS: Scenario[] = [
  {
    id: "find-unique",
    title: "findUnique by id",
    description: "One user by its unique id (indexed), all scalar fields.",
    group: "read",
    raw: (run, { fx }) => {
      const id = cycle(fx.userIds);
      return {
        fn: () => run(`MATCH (u:User {id: $id}) RETURN ${USER} AS u`, { id: id() }, "read"),
        summarize: (r) => first<{ u: Row }>(r).u.email,
      };
    },
    cyphra: (db, { fx }) => {
      const id = cycle(fx.userIds);
      return {
        fn: () => db.user.findUnique({ where: { id: id() } }),
        summarize: (r) => (r as Row).email,
      };
    },
    neogma: ({ Users }, { fx }) => {
      const id = cycle(fx.userIds);
      return {
        fn: () => Users.findOne({ where: { id: id() }, plain: true }),
        summarize: (r) => (r as Row).email,
      };
    },
    graphql: (exec, { fx }) => {
      const id = cycle(fx.userIds);
      return {
        fn: () =>
          exec(`query ($id: ID!) { users(where: { id: { eq: $id } }) { ${GQL_USER} } }`, {
            id: id(),
          }),
        summarize: (r) => (r as { users: Row[] }).users[0]!.email,
      };
    },
  },
  {
    id: "find-many",
    title: "findMany, filter + order + limit 50",
    description: "Users in a 10-year age window (range index), sorted by name, first 50.",
    group: "read",
    raw: (run, { fx }) => {
      const floor = cycle(fx.ageFloors);
      return {
        fn: () => {
          const a = floor();
          return run(
            `MATCH (u:User) WHERE u.age >= $min AND u.age < $max
             WITH u ORDER BY u.name LIMIT $take
             RETURN ${USER} AS u`,
            { min: int(a), max: int(a + 10), take: int(50) },
            "read",
          );
        },
        summarize: (r) => [len(r), first<{ u: Row }>(r).u.email],
      };
    },
    cyphra: (db, { fx }) => {
      const floor = cycle(fx.ageFloors);
      return {
        fn: () => {
          const a = floor();
          return db.user.findMany({
            where: { age: { gte: a, lt: a + 10 } },
            orderBy: { name: "asc" },
            take: 50,
          });
        },
        summarize: (r) => [len(r), first(r).email],
      };
    },
    neogma: ({ Users }, { fx }) => {
      const floor = cycle(fx.ageFloors);
      return {
        fn: () => {
          const a = floor();
          return Users.findMany({
            where: { age: { [Op.gte]: a, [Op.lt]: a + 10 } },
            order: [["name", "ASC"]],
            limit: 50,
            plain: true,
          });
        },
        summarize: (r) => [len(r), first(r).email],
      };
    },
    graphql: (exec, { fx }) => {
      const floor = cycle(fx.ageFloors);
      return {
        fn: () => {
          const a = floor();
          return exec(
            `query ($min: Int!, $max: Int!) {
               users(where: { age: { gte: $min, lt: $max } }, sort: [{ name: ASC }], limit: 50) {
                 ${GQL_USER}
               }
             }`,
            { min: a, max: a + 10 },
          );
        },
        summarize: (r) => {
          const users = (r as { users: Row[] }).users;
          return [users.length, users[0]!.email];
        },
      };
    },
  },
  {
    id: "nested-read",
    title: "Nested read, 2 levels",
    description: "10 users by id, each with its posts and each post's comments (about 150 nodes).",
    group: "read",
    raw: (run, { fx }) => {
      const ids = cycle(fx.authorBatches);
      return {
        fn: () =>
          run(
            `MATCH (u:User) WHERE u.id IN $ids
             RETURN u {.id, .email, .name, .age, .createdAt,
               posts: COLLECT {
                 MATCH (u)-[:AUTHORED]->(p:Post)
                 RETURN p {.id, .title, .views, .published,
                   comments: COLLECT { MATCH (p)-[:HAS_COMMENT]->(c:Comment) RETURN c {.id, .text} }}
               }} AS u`,
            { ids: ids() },
            "read",
          ),
        summarize: (r) =>
          (r as { u: { posts: { comments: unknown[] }[] } }[])
            .flatMap((x) => x.u.posts)
            .reduce((n, p) => n + p.comments.length, 0),
      };
    },
    cyphra: (db, { fx }) => {
      const ids = cycle(fx.authorBatches);
      return {
        fn: () =>
          db.user.findMany({
            where: { id: { in: ids() } },
            include: { posts: { include: { comments: true } } },
          }),
        summarize: (r) =>
          (r as { posts: { comments: unknown[] }[] }[])
            .flatMap((u) => u.posts)
            .reduce((n, p) => n + p.comments.length, 0),
      };
    },
    neogma: ({ Users }, { fx }) => {
      const ids = cycle(fx.authorBatches);
      return {
        fn: () =>
          Users.findMany({
            where: { id: { [Op.in]: ids() } },
            relationships: { posts: { relationships: { comments: {} } } },
            plain: true,
          }),
        summarize: (r) =>
          (r as { posts?: { node: { comments?: unknown[] } }[] }[])
            .flatMap((u) => u.posts ?? [])
            .reduce((n, p) => n + (p.node.comments?.length ?? 0), 0),
      };
    },
    graphql: (exec, { fx }) => {
      const ids = cycle(fx.authorBatches);
      return {
        fn: () =>
          exec(
            `query ($ids: [ID!]!) {
               users(where: { id: { in: $ids } }) {
                 ${GQL_USER}
                 posts { id title views published comments { id text } }
               }
             }`,
            { ids: ids() },
          ),
        summarize: (r) =>
          (r as { users: { posts: { comments: unknown[] }[] }[] }).users
            .flatMap((u) => u.posts)
            .reduce((n, p) => n + p.comments.length, 0),
      };
    },
  },
  {
    id: "create",
    title: "create",
    description: "One user with four scalar fields; returns the created node.",
    group: "write",
    writes: true,
    raw: (run, { prefix }) => {
      let n = 0;
      return {
        fn: () => {
          const i = n++;
          return run(
            `CREATE (u:User {id: $id, email: $email, name: $name, age: $age, createdAt: datetime()})
             RETURN ${USER} AS u`,
            { id: randomUUID(), email: `${prefix}${i}@bench.test`, name: `New ${i}`, age: int(30) },
            "write",
          );
        },
        summarize: (r) => first<{ u: Row }>(r).u.name,
      };
    },
    cyphra: (db, { prefix }) => {
      let n = 0;
      return {
        fn: () => {
          const i = n++;
          return db.user.create({
            data: { email: `${prefix}${i}@bench.test`, name: `New ${i}`, age: 30 },
          });
        },
        summarize: (r) => (r as Row).name,
      };
    },
    neogma: ({ Users }, { prefix }) => {
      let n = 0;
      return {
        fn: () => {
          const i = n++;
          return Users.createOne({
            id: randomUUID(),
            email: `${prefix}${i}@bench.test`,
            name: `New ${i}`,
            age: 30,
          });
        },
        summarize: (r) => (r as { name: string }).name,
      };
    },
    graphql: (exec, { prefix }) => {
      let n = 0;
      return {
        fn: () => {
          const i = n++;
          return exec(
            `mutation ($email: String!, $name: String!) {
               createUsers(input: [{ email: $email, name: $name, age: 30 }]) { users { ${GQL_USER} } }
             }`,
            { email: `${prefix}${i}@bench.test`, name: `New ${i}` },
          );
        },
        summarize: (r) => (r as { createUsers: { users: Row[] } }).createUsers.users[0]!.name,
      };
    },
  },
  {
    id: "nested-create",
    title: "Nested create (user + 5 posts)",
    description: "One user and five posts linked to it, in one transaction; returns them.",
    group: "write",
    writes: true,
    raw: (run, env) => {
      const { prefix } = env;
      let n = 0;
      return {
        fn: () => {
          const i = n++;
          return run(
            `CREATE (u:User {id: $id, email: $email, name: $name, age: $age, createdAt: datetime()})
             WITH u
             UNWIND $posts AS p
             CREATE (u)-[:AUTHORED]->(post:Post {id: randomUUID(), title: p.title,
                                                 views: toInteger(p.views), published: p.published})
             WITH u, collect(post {.id, .title, .views, .published}) AS posts
             RETURN u {.id, .email, .name, .age, .createdAt, posts: posts} AS u`,
            {
              id: randomUUID(),
              email: `${prefix}${i}@bench.test`,
              name: `New ${i}`,
              age: int(30),
              posts: newPosts(i),
            },
            "write",
          );
        },
        summarize: (r) => (first<{ u: { posts: unknown[] } }>(r).u.posts as unknown[]).length,
        verify: verifyNestedCreate(env),
      };
    },
    cyphra: (db, env) => {
      const { prefix } = env;
      let n = 0;
      return {
        fn: () => {
          const i = n++;
          return db.user.create({
            data: {
              email: `${prefix}${i}@bench.test`,
              name: `New ${i}`,
              age: 30,
              posts: { create: newPosts(i) },
            },
            include: { posts: true },
          });
        },
        summarize: (r) => (r as { posts: unknown[] }).posts.length,
        verify: verifyNestedCreate(env),
      };
    },
    neogma: ({ Users }, env) => {
      const { prefix } = env;
      let n = 0;
      return {
        fn: () => {
          const i = n++;
          return Users.createOne({
            id: randomUUID(),
            email: `${prefix}${i}@bench.test`,
            name: `New ${i}`,
            age: 30,
            posts: { properties: newPosts(i).map((p) => ({ id: randomUUID(), ...p })) },
          });
        },
        verify: verifyNestedCreate(env),
      };
    },
    graphql: (exec, env) => {
      const { prefix } = env;
      let n = 0;
      return {
        fn: () => {
          const i = n++;
          return exec(
            `mutation ($input: [UserCreateInput!]!) {
               createUsers(input: $input) {
                 users { ${GQL_USER} posts { id title views published } }
               }
             }`,
            {
              input: [
                {
                  email: `${prefix}${i}@bench.test`,
                  name: `New ${i}`,
                  age: 30,
                  posts: { create: newPosts(i).map((node) => ({ node })) },
                },
              ],
            },
          );
        },
        summarize: (r) =>
          (r as { createUsers: { users: { posts: unknown[] }[] } }).createUsers.users[0]!.posts
            .length,
        verify: verifyNestedCreate(env),
      };
    },
  },
  {
    id: "upsert",
    title: "upsert",
    description:
      "MERGE on the unique email over 20 keys: the first call per key creates, then updates.",
    group: "write",
    writes: true,
    raw: (run, { prefix }) => {
      let n = 0;
      return {
        fn: () => {
          const i = n++;
          return run(
            `MERGE (u:User {email: $email})
             ON CREATE SET u.id = $id, u.name = $name, u.age = $age, u.createdAt = datetime()
             ON MATCH SET u.name = $name
             RETURN ${USER} AS u`,
            {
              email: `${prefix}${i % 20}@bench.test`,
              id: randomUUID(),
              name: `Upsert ${i}`,
              age: int(30),
            },
            "write",
          );
        },
        summarize: (r) => first<{ u: Row }>(r).u.name,
      };
    },
    cyphra: (db, { prefix }) => {
      let n = 0;
      return {
        fn: () => {
          const i = n++;
          return db.user.upsert({
            where: { email: `${prefix}${i % 20}@bench.test` },
            create: { email: `${prefix}${i % 20}@bench.test`, name: `Upsert ${i}`, age: 30 },
            update: { name: `Upsert ${i}` },
          });
        },
        summarize: (r) => (r as Row).name,
      };
    },
    na: {
      neogma: "no upsert (createOne with merge MERGEs on every property)",
      graphql: "no upsert mutation in @neo4j/graphql",
    },
  },
  {
    id: "update",
    title: "update by unique",
    description: "Set one field of a user found by id; returns the updated node.",
    group: "write",
    raw: (run, { fx }) => {
      const id = cycle(fx.userIds);
      let n = 0;
      return {
        fn: () =>
          run(
            `MATCH (u:User {id: $id}) SET u.name = $name RETURN ${USER} AS u`,
            { id: id(), name: `Renamed ${n++}` },
            "write",
          ),
        summarize: (r) => first<{ u: Row }>(r).u.name,
      };
    },
    cyphra: (db, { fx }) => {
      const id = cycle(fx.userIds);
      let n = 0;
      return {
        fn: () => db.user.update({ where: { id: id() }, data: { name: `Renamed ${n++}` } }),
        summarize: (r) => (r as Row).name,
      };
    },
    neogma: ({ Users }, { fx }) => {
      const id = cycle(fx.userIds);
      let n = 0;
      return {
        fn: () => Users.update({ name: `Renamed ${n++}` }, { where: { id: id() }, return: true }),
        summarize: (r) => (r as [{ name: string }[]])[0][0]!.name,
      };
    },
    graphql: (exec, { fx }) => {
      const id = cycle(fx.userIds);
      let n = 0;
      return {
        fn: () =>
          exec(
            `mutation ($id: ID!, $name: String!) {
               updateUsers(where: { id: { eq: $id } }, update: { name: { set: $name } }) {
                 users { ${GQL_USER} }
               }
             }`,
            { id: id(), name: `Renamed ${n++}` },
          ),
        summarize: (r) => (r as { updateUsers: { users: Row[] } }).updateUsers.users[0]!.name,
      };
    },
  },
  {
    id: "delete-cascade",
    title: "delete with cascade",
    description:
      "Delete a user, its 3 posts and their 6 comments (onDelete: Cascade). The user is created before each call, unmeasured.",
    group: "write",
    writes: true,
    raw: (run, env) => {
      const del = deleteFixture(env);
      return {
        beforeEach: del.create,
        fn: () =>
          run(
            `MATCH (u:User {id: $id})
             OPTIONAL MATCH (u)-[:AUTHORED]->(p:Post)
             OPTIONAL MATCH (p)-[:HAS_COMMENT]->(c:Comment)
             WITH u, ${USER} AS row, collect(DISTINCT p) AS posts, collect(DISTINCT c) AS comments
             FOREACH (x IN comments | DETACH DELETE x)
             FOREACH (x IN posts | DETACH DELETE x)
             DETACH DELETE u
             RETURN row AS u`,
            { id: del.current() },
            "write",
          ),
        verify: del.verify,
      };
    },
    cyphra: (db, env) => {
      const del = deleteFixture(env);
      return {
        beforeEach: del.create,
        fn: () => db.user.delete({ where: { id: del.current() } }),
        verify: del.verify,
      };
    },
    graphql: (exec, env) => {
      const del = deleteFixture(env);
      return {
        beforeEach: del.create,
        fn: () =>
          exec(
            `mutation ($id: ID!) {
               deleteUsers(
                 where: { id: { eq: $id } }
                 delete: { posts: [{ where: {}, delete: { comments: [{ where: {} }] } }] }
               ) { nodesDeleted }
             }`,
            { id: del.current() },
          ),
        summarize: (r) => (r as { deleteUsers: { nodesDeleted: number } }).deleteUsers.nodesDeleted,
        verify: del.verify,
      };
    },
    na: { neogma: "no cascading delete (detach only)" },
  },
  {
    id: "relation-count",
    title: "Relation count",
    description: "10 users by id, each with its number of posts and of followers.",
    group: "read",
    raw: (run, { fx }) => {
      const ids = cycle(fx.authorBatches);
      return {
        fn: () =>
          run(
            `MATCH (u:User) WHERE u.id IN $ids
             RETURN u {.id, .email, .name, .age, .createdAt,
               _count: {posts: COUNT { (u)-[:AUTHORED]->(:Post) },
                        followers: COUNT { (u)<-[:FOLLOWS]-(:User) }}} AS u`,
            { ids: ids() },
            "read",
          ),
        summarize: (r) =>
          (r as { u: { _count: { posts: number; followers: number } } }[]).reduce(
            (n, x) => n + x.u._count.posts + x.u._count.followers,
            0,
          ),
      };
    },
    cyphra: (db, { fx }) => {
      const ids = cycle(fx.authorBatches);
      return {
        fn: () =>
          db.user.findMany({
            where: { id: { in: ids() } },
            include: { _count: { select: { posts: true, followers: true } } },
          }),
        summarize: (r) =>
          (r as { _count: { posts: number; followers: number } }[]).reduce(
            (n, u) => n + u._count.posts + u._count.followers,
            0,
          ),
      };
    },
    graphql: (exec, { fx }) => {
      const ids = cycle(fx.authorBatches);
      return {
        fn: () =>
          exec(
            `query ($ids: [ID!]!) {
               users(where: { id: { in: $ids } }) {
                 ${GQL_USER}
                 postsConnection { aggregate { count { nodes } } }
                 followersConnection { aggregate { count { nodes } } }
               }
             }`,
            { ids: ids() },
          ),
        summarize: (r) => {
          type C = { aggregate: { count: { nodes: number } } };
          return (r as { users: { postsConnection: C; followersConnection: C }[] }).users.reduce(
            (n, u) =>
              n +
              u.postsConnection.aggregate.count.nodes +
              u.followersConnection.aggregate.count.nodes,
            0,
          );
        },
      };
    },
    na: { neogma: "no relation count API" },
  },
  {
    id: "aggregate",
    title: "aggregate",
    description: "Count, average and max of `views` over the published posts (half of all posts).",
    group: "read",
    raw: (run) => ({
      fn: () =>
        run(
          `MATCH (p:Post) WHERE p.published = true
           RETURN count(p) AS count, avg(p.views) AS avg, max(p.views) AS max`,
          {},
          "read",
        ),
      summarize: (r) => first(r).count,
    }),
    cyphra: (db) => ({
      fn: () =>
        db.post.aggregate({
          where: { published: true },
          _count: true,
          _avg: { views: true },
          _max: { views: true },
        }),
      summarize: (r) => (r as { _count: number })._count,
    }),
    graphql: (exec) => ({
      fn: () =>
        exec(`query {
          postsConnection(where: { published: { eq: true } }) {
            aggregate { count { nodes } node { views { average max } } }
          }
        }`),
      summarize: (r) =>
        (r as { postsConnection: { aggregate: { count: { nodes: number } } } }).postsConnection
          .aggregate.count.nodes,
    }),
    na: { neogma: "no aggregation API" },
  },
  {
    id: "group-by",
    title: "groupBy",
    description: "Posts grouped by `published`: count and average `views` per group.",
    group: "read",
    raw: (run) => ({
      fn: () =>
        run(
          `MATCH (p:Post)
           RETURN p.published AS published, count(p) AS count, avg(p.views) AS avg
           ORDER BY published`,
          {},
          "read",
        ),
      summarize: (r) => (r as { count: number }[]).map((g) => g.count),
    }),
    cyphra: (db) => ({
      fn: () =>
        db.post.groupBy({
          by: ["published"],
          _count: { _all: true },
          _avg: { views: true },
          orderBy: { published: "asc" },
        }),
      summarize: (r) => (r as { _count: { _all: number } }[]).map((g) => g._count._all),
    }),
    na: { neogma: "no aggregation API", graphql: "no groupBy in @neo4j/graphql" },
  },
  {
    id: "traverse-3-hops",
    title: "3-hop traversal",
    description:
      "Everyone reachable within 3 FOLLOWS hops of a user (about 150 distinct users), all scalar fields.",
    group: "graph",
    raw: (run, { fx }) => {
      const id = cycle(fx.userIds);
      return {
        fn: () =>
          run(
            `MATCH (s:User {id: $id})
             MATCH (s)-[:FOLLOWS]->{1,3}(n:User) WHERE n <> s
             WITH DISTINCT n
             RETURN n {.id, .email, .name, .age, .createdAt} AS n`,
            { id: id() },
            "read",
          ),
        summarize: len,
      };
    },
    cyphra: (db, { fx }) => {
      const id = cycle(fx.userIds);
      return {
        fn: () => db.user.traverse({ from: { id: id() }, via: "following", depth: { max: 3 } }),
        summarize: len,
      };
    },
    na: {
      neogma: "findRelationships returns one row per path, not distinct nodes",
      graphql: "no traversal without a custom @cypher field",
    },
  },
  {
    id: "shortest-path",
    title: "Shortest path",
    description: "One shortest FOLLOWS path (at most 8 hops) between two connected users.",
    group: "graph",
    raw: (run, { fx }) => {
      const pair = cycle(fx.pathPairs);
      return {
        fn: () => {
          const [from, to] = pair();
          return run(
            `MATCH (s:User {id: $from}) MATCH (t:User {id: $to})
             MATCH p = SHORTEST 1 (s)-[:FOLLOWS]->{0,8}(t)
             RETURN [n IN nodes(p) | n {.id, .email, .name, .age, .createdAt}] AS nodes`,
            { from, to },
            "read",
          );
        },
        summarize: (r) => (first<{ nodes: unknown[] }>(r).nodes as unknown[]).length,
      };
    },
    cyphra: (db, { fx }) => {
      const pair = cycle(fx.pathPairs);
      return {
        fn: () => {
          const [from, to] = pair();
          return db.user.shortestPath({
            from: { id: from },
            to: { id: to },
            via: "following",
            maxDepth: 8,
          });
        },
        summarize: (r) => (r as { nodes: unknown[] }).nodes.length,
      };
    },
    na: { neogma: "no path API", graphql: "no path API without @cypher" },
  },
  {
    id: "find-similar",
    title: "Vector findSimilar (k = 10)",
    description: "The 10 nearest documents to a query vector (384 dims, cosine vector index).",
    group: "graph",
    raw: (run, { fx }) => {
      const v = cycle(fx.queryVectors);
      return {
        fn: () =>
          run(
            `CALL db.index.vector.queryNodes('Doc_embedding_vector', $k, $vector)
             YIELD node, score
             RETURN node {.id, .title} AS doc, score`,
            { k: int(10), vector: v() },
            "read",
          ),
        summarize: (r) => (r as { doc: Row }[]).map((x) => x.doc.id).join(),
      };
    },
    cyphra: (db, { fx }) => {
      const v = cycle(fx.queryVectors);
      return {
        fn: () =>
          db.doc.findSimilar({
            field: "embedding",
            vector: v(),
            k: 10,
            select: { id: true, title: true },
          }),
        summarize: (r) => (r as Row[]).map((d) => d.id).join(),
      };
    },
    na: { neogma: "no vector search API", graphql: "not compared (vector support differs)" },
  },
];

/** After the first nested create: the user exists with its 5 posts. */
function verifyNestedCreate({ prefix, setup }: Env) {
  return async () => {
    const rows = await setup(
      `MATCH (u:User {email: $email}) RETURN COUNT { (u)-[:AUTHORED]->(:Post) } AS posts`,
      { email: `${prefix}0@bench.test` },
      "read",
    );
    if (rows[0]?.posts !== POSTS_PER_NESTED_CREATE)
      throw new Error(
        `nested-create: expected ${POSTS_PER_NESTED_CREATE} posts, got ${rows[0]?.posts}`,
      );
  };
}

/**
 * The node a delete scenario removes: a user with 3 posts of 2 comments each, created by the raw
 * driver before each measured call.
 */
function deleteFixture({ prefix, setup }: Env) {
  let n = 0;
  let id = "";
  return {
    current: () => id,
    create: async () => {
      id = `${prefix}${n++}`;
      await setup(
        `CREATE (u:User {id: $id, email: $id + '@bench.test', name: 'To delete', age: 40,
                         createdAt: datetime()})
         WITH u UNWIND range(1, 3) AS k
         CREATE (u)-[:AUTHORED]->(p:Post {id: $id + '-p' + k, title: 'Doomed', views: 0,
                                          published: false})
         WITH p UNWIND range(1, 2) AS j
         CREATE (p)-[:HAS_COMMENT]->(:Comment {id: p.id + '-c' + j, text: 'Doomed'})`,
        { id },
        "write",
      );
    },
    verify: async () => {
      const rows = await setup(
        `MATCH (n) WHERE (n:User OR n:Post OR n:Comment) AND n.id STARTS WITH $id
         RETURN count(n) AS left`,
        { id },
        "read",
      );
      if (rows[0]!.left !== 0) throw new Error(`delete-cascade: ${rows[0]!.left} nodes left`);
    },
  };
}
