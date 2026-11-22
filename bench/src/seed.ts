/**
 * Deterministic data set, written with the raw driver (not measured): a social graph of users who
 * follow each other, posts and comments of the first `authors` users, and documents with
 * embeddings. Constraints and indexes come from schema.cyphra (the DDL `cyphra push` runs), so every
 * contender reads and writes the same indexed data.
 */
import { readFileSync } from "node:fs";
import {
  constraintStatementsFromSchema,
  indexStatementsFromSchema,
  vectorIndexStatementsFromSchema,
} from "@cyphra/migrator";
import { parseSchema } from "@cyphra/schema";
import neo4j, { type Driver } from "neo4j-driver";
import type { Sizes } from "./config.js";

/** mulberry32: a small seeded PRNG, so every run builds the same graph. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const LABELS = ["User", "Post", "Comment", "Doc"] as const;

export const userId = (i: number) => `u${i}`;
export const postId = (i: number) => `p${i}`;

/** A unit vector of `dims` floats. */
export function randomVector(rand: () => number, dims: number): number[] {
  const v = Array.from({ length: dims }, () => rand() * 2 - 1);
  const norm = Math.hypot(...v);
  return v.map((x) => x / norm);
}

export type Fixtures = {
  sizes: Sizes;
  /** Ids looked up by findUnique / update, in a fixed pseudo-random order. */
  userIds: string[];
  /** Lists of 10 author ids (users with posts) for the nested read and relation count. */
  authorBatches: string[][];
  /** Lower bounds of the `age` window of findMany. */
  ageFloors: number[];
  /** (from, to) user ids joined by a FOLLOWS path, for the shortest path scenario. */
  pathPairs: [string, string][];
  /** Query vectors for findSimilar. */
  queryVectors: number[][];
};

async function run(driver: Driver, database: string, cypher: string, params = {}) {
  const session = driver.session({ database });
  try {
    return await session.run(cypher, params);
  } finally {
    await session.close();
  }
}

async function inBatches<T>(rows: T[], size: number, fn: (batch: T[]) => Promise<unknown>) {
  for (let i = 0; i < rows.length; i += size) await fn(rows.slice(i, i + size));
}

/** Deletes every node of the benchmark labels (in batches, to stay within the heap). */
export async function wipe(driver: Driver, database: string): Promise<void> {
  await run(
    driver,
    database,
    `MATCH (n) WHERE n:User OR n:Post OR n:Comment OR n:Doc
     CALL (n) { DETACH DELETE n } IN TRANSACTIONS OF 5000 ROWS`,
  );
}

/** The constraints and indexes `cyphra push` would create for schema.cyphra. */
export function schemaStatements(): string[] {
  const doc = parseSchema(readFileSync(new URL("../schema.cyphra", import.meta.url), "utf8"));
  return [
    ...constraintStatementsFromSchema(doc),
    ...indexStatementsFromSchema(doc),
    ...vectorIndexStatementsFromSchema(doc),
  ];
}

export async function applySchema(driver: Driver, database: string): Promise<void> {
  for (const statement of schemaStatements()) {
    try {
      await run(driver, database, statement);
    } catch (e) {
      // Another suite (CI shares the database) may already hold an equivalent index.
      if (!String((e as { code?: string }).code).includes("AlreadyExists")) throw e;
    }
  }
}

export async function seed(driver: Driver, database: string, sizes: Sizes): Promise<Fixtures> {
  const rand = rng(42);
  const pick = (n: number) => Math.floor(rand() * n);

  await wipe(driver, database);
  await applySchema(driver, database);

  const users = Array.from({ length: sizes.users }, (_, i) => ({
    id: userId(i),
    email: `user${i}@bench.test`,
    name: `User ${String(pick(1_000_000)).padStart(6, "0")} ${i}`,
    age: 18 + pick(62),
    createdAt: new Date(Date.UTC(2020, 0, 1) + pick(5 * 365) * 86_400_000).toISOString(),
  }));
  await inBatches(users, 5_000, (rows) =>
    run(
      driver,
      database,
      `UNWIND $rows AS r
       CREATE (:User {id: r.id, email: r.email, name: r.name, age: toInteger(r.age),
                      createdAt: datetime(r.createdAt)})`,
      { rows },
    ),
  );

  const follows: { a: string; b: string }[] = [];
  for (let i = 0; i < sizes.users; i++) {
    const targets = new Set<number>();
    while (targets.size < Math.min(sizes.followsPerUser, sizes.users - 1)) {
      const t = pick(sizes.users);
      if (t !== i) targets.add(t);
    }
    for (const t of targets) follows.push({ a: userId(i), b: userId(t) });
  }
  await inBatches(follows, 10_000, (rows) =>
    run(
      driver,
      database,
      `UNWIND $rows AS r
       MATCH (a:User {id: r.a}) MATCH (b:User {id: r.b})
       CREATE (a)-[:FOLLOWS]->(b)`,
      { rows },
    ),
  );

  const posts: { id: string; author: string; title: string; views: number; published: boolean }[] =
    [];
  for (let a = 0; a < sizes.authors; a++) {
    for (let k = 0; k < sizes.postsPerAuthor; k++) {
      const i = posts.length;
      posts.push({
        id: postId(i),
        author: userId(a),
        title: `Post ${i} by user ${a}`,
        views: pick(10_000),
        published: i % 2 === 0,
      });
    }
  }
  await inBatches(posts, 5_000, (rows) =>
    run(
      driver,
      database,
      `UNWIND $rows AS r
       MATCH (u:User {id: r.author})
       CREATE (u)-[:AUTHORED]->(:Post {id: r.id, title: r.title, views: toInteger(r.views),
                                       published: r.published})`,
      { rows },
    ),
  );

  const comments = posts.flatMap((p, i) =>
    Array.from({ length: sizes.commentsPerPost }, (_, k) => ({
      id: `c${i * sizes.commentsPerPost + k}`,
      post: p.id,
      text: `Comment ${k} on ${p.id}`,
    })),
  );
  await inBatches(comments, 5_000, (rows) =>
    run(
      driver,
      database,
      `UNWIND $rows AS r
       MATCH (p:Post {id: r.post})
       CREATE (p)-[:HAS_COMMENT]->(:Comment {id: r.id, text: r.text})`,
      { rows },
    ),
  );

  const docs = Array.from({ length: sizes.docs }, (_, i) => ({
    id: `d${i}`,
    title: `Document ${i}`,
    embedding: randomVector(rand, sizes.dims),
  }));
  await inBatches(docs, 500, (rows) =>
    run(
      driver,
      database,
      `UNWIND $rows AS r CREATE (:Doc {id: r.id, title: r.title, embedding: r.embedding})`,
      { rows },
    ),
  );

  await run(driver, database, "CALL db.awaitIndexes(600)");

  const userIds = Array.from({ length: 1_000 }, () => userId(pick(sizes.users)));
  const authorBatches = Array.from({ length: 100 }, () =>
    Array.from({ length: 10 }, () => userId(pick(sizes.authors))),
  );
  const ageFloors = Array.from({ length: 100 }, () => 18 + pick(50));

  // Pairs actually joined by a path of at most 8 hops, found once with plain Cypher.
  const pathPairs: [string, string][] = [];
  for (let tries = 0; pathPairs.length < 50 && tries < 500; tries++) {
    const from = userId(pick(sizes.users));
    const to = userId(pick(sizes.users));
    if (from === to) continue;
    const res = await run(
      driver,
      database,
      `MATCH (s:User {id: $from}) MATCH (t:User {id: $to})
       RETURN EXISTS { (s)-[:FOLLOWS*1..8]->(t) } AS ok`,
      { from, to },
    );
    if (res.records[0]?.get("ok")) pathPairs.push([from, to]);
  }
  if (pathPairs.length === 0) throw new Error("seed: no connected user pairs found");

  const queryVectors = Array.from({ length: 50 }, () => randomVector(rand, sizes.dims));

  return { sizes, userIds, authorBatches, ageFloors, pathPairs, queryVectors };
}

/** Graph size actually in the database, for the results file. */
export async function counts(driver: Driver, database: string) {
  const res = await run(
    driver,
    database,
    `RETURN COUNT { (:User) } AS users, COUNT { ()-[:FOLLOWS]->() } AS follows,
            COUNT { (:Post) } AS posts, COUNT { (:Comment) } AS comments, COUNT { (:Doc) } AS docs`,
  );
  const r = res.records[0]!;
  const n = (k: string) => neo4j.integer.toNumber(r.get(k));
  return {
    users: n("users"),
    follows: n("follows"),
    posts: n("posts"),
    comments: n("comments"),
    docs: n("docs"),
  };
}
