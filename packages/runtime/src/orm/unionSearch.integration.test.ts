import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createClient, type Db } from "./__fixtures__/unionSearch.gen.js";
import { CyphraValidationError } from "./errors.js";
import {
  hasTestDb,
  onFalkorDB,
  onMemgraph,
  retryStorageAccess,
  testConnection,
  testDdl,
} from "./__fixtures__/testDialect.js";

// Index creation and the first queries can be slow on a busy CI runner.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 120_000 });

const LABELS = ["UsArticle", "UsAuthor", "UsEditor", "UsReviewer", "UsPerson", "UsTag"];

// Same statements as `cyphra push` / migrations generate for __fixtures__/unionSearch.cyphra
// (translated for Memgraph and FalkorDB by testDdl).
const ft = (name: string, label: string, props: string[]) =>
  `CREATE FULLTEXT INDEX ${name} IF NOT EXISTS FOR (n:\`${label}\`) ON EACH [${props.map((p) => `n.\`${p}\``).join(", ")}] OPTIONS {indexConfig: {\`fulltext.eventually_consistent\`: false}}`;
const vec = (name: string, label: string, fn: string) =>
  `CREATE VECTOR INDEX ${name} IF NOT EXISTS FOR (n:\`${label}\`) ON n.\`embedding\` OPTIONS {indexConfig: {\`vector.dimensions\`: 3, \`vector.similarity_function\`: '${fn}'}}`;
const DDL = [
  ft("usArticleText", "UsArticle", ["title", "body"]),
  ft("usAuthorName", "UsAuthor", ["name"]),
  ft("usAuthorBio", "UsAuthor", ["bio"]),
  ft("usPersonAbout", "UsPerson", ["about"]),
  vec("usArticleEmbedding", "UsArticle", "cosine"),
  vec("usAuthorEmbedding", "UsAuthor", "euclidean"),
  vec("usEditorEmbedding", "UsEditor", "cosine"),
];

type Seeder = Pick<Db, "usTag" | "usArticle" | "usAuthor" | "usEditor" | "usReviewer">;

const rrf = (ranks: number[], k = 60) => ranks.reduce((s, r) => s + 1 / (k + r), 0);

describe.skipIf(!hasTestDb)("search and findSimilar over a union", () => {
  let db: Db;

  const schema = (text: string) =>
    retryStorageAccess(() =>
      db.$client.withSession(async (s) => {
        try {
          await s.run(text);
        } catch (e) {
          // Memgraph's and FalkorDB's index DDL has no IF NOT EXISTS.
          if (!/already exists|already indexed/i.test((e as Error).message)) throw e;
        }
      }),
    );

  beforeAll(async () => {
    db = createClient({ ...testConnection() });
    await db.$cypher`MATCH (n) WHERE any(l IN labels(n) WHERE l IN ${LABELS}) DETACH DELETE n`;
    for (const stmt of DDL) {
      const statement = testDdl(stmt);
      if (statement) await schema(statement);
    }
    if (!onMemgraph && !onFalkorDB) await schema("CALL db.awaitIndexes(120)");
    // One transaction: Memgraph commits its text indexes once per write transaction (FalkorDB
    // has no multi-statement transactions).
    const seed = async (tx: Seeder) => {
      await tx.usTag.create({ data: { id: "t1", name: "db" } });
      await tx.usArticle.create({
        data: {
          id: "a1",
          title: "Graph databases",
          body: "graph storage for graph data",
          embedding: [1, 0, 0],
          tags: { connect: { id: "t1" } },
        },
      });
      await tx.usArticle.create({
        data: {
          id: "a2",
          title: "Cooking",
          body: "a graph of recipes",
          published: false,
          embedding: [0.8, 0.6, 0],
        },
      });
      await tx.usArticle.create({
        data: { id: "a3", title: "Gardening", body: "plants", embedding: [0, 1, 0] },
      });
      await tx.usAuthor.create({
        data: {
          id: "w1",
          name: "Graph Gopher",
          bio: "writes long essays about the theory of graph structures",
          embedding: [1, 0, 0],
        },
      });
      await tx.usAuthor.create({
        data: { id: "w2", name: "Ada", bio: "graph", embedding: [0, 0, 1] },
      });
      await tx.usEditor.create({
        data: { id: "e1", email: "e1@x.io", about: "edits graph books", embedding: [0.6, 0.8, 0] },
      });
      await tx.usReviewer.create({
        data: { id: "r1", email: "r1@x.io", about: "reviews graph papers" },
      });
    };
    if (onFalkorDB) await seed(db);
    else await db.$transaction(seed);
  });

  afterAll(async () => {
    if (!db) return;
    await db.$cypher`MATCH (n) WHERE any(l IN labels(n) WHERE l IN ${LABELS}) DETACH DELETE n`;
    await db.$disconnect();
  });

  const ALL = {
    UsArticle: "usArticleText",
    UsAuthor: "usAuthorBio",
    UsEditor: "usPersonAbout",
  } as const;
  const ids = (rows: readonly { id?: string }[]) => rows.map((r) => r.id);

  it("ranks each member's index on its own and fuses the lists by rank", async () => {
    const hits = await db.usHit.search({
      query: "graph",
      mode: "terms",
      indexes: ALL,
      scores: true,
    });
    // Every member's hits; the reviewer (in the inherited index, not a member) is left out.
    expect([...ids(hits)].sort()).toEqual(["a1", "a2", "e1", "w1", "w2"]);
    // Each list's best hit ties at 1 / (60 + 1): broken by normalised score (1), then member order.
    expect(hits.slice(0, 3).map((h) => h.__typename)).toEqual([
      "UsArticle",
      "UsAuthor",
      "UsEditor",
    ]);
    // The second hits tie at 1 / (60 + 2), broken by normalised score (FalkorDB's UsAuthor index
    // covers name and bio, so its two hits may score the same: both normalised to 1).
    const second = hits.slice(3).map((h) => h.__typename);
    expect(onFalkorDB ? [...second].sort() : second).toEqual(["UsArticle", "UsAuthor"]);
    for (const h of hits) {
      const parts = Object.values(h.$scores);
      expect(parts).toHaveLength(1);
      expect(h.$score).toBeCloseTo(rrf(parts.map((p) => p.rank)), 12);
    }
    const editor = hits.find((h) => h.__typename === "UsEditor")!;
    expect(editor.$scores).toEqual({
      usPersonAbout: { score: expect.any(Number), normalized: 1, rank: 1 },
    });
    const ranked = hits.filter((h) => h.__typename === "UsArticle");
    expect(ranked.map((h) => h.$scores.usArticleText!.rank)).toEqual([1, 2]);
    expect(ranked[0]!.$scores.usArticleText!.normalized).toBe(1);
    // FalkorDB (RediSearch) can score both hits the same: then both normalise to 1.
    expect(ranked[1]!.$scores.usArticleText!.normalized).toBe(
      onFalkorDB
        ? ranked[1]!.$scores.usArticleText!.score === ranked[0]!.$scores.usArticleText!.score
          ? 1
          : 0
        : 0,
    );
    // Without scores: true, no $scores.
    const plain = await db.usHit.search({ query: "graph", mode: "terms", indexes: ALL });
    expect(ids(plain)).toEqual(ids(hits));
    expect(plain.every((h) => !("$scores" in h))).toBe(true);
  });

  it("pages after fusion and takes rrfK", async () => {
    const all = await db.usHit.search({ query: "graph", mode: "terms", indexes: ALL });
    const page = await db.usHit.search({
      query: "graph",
      mode: "terms",
      indexes: ALL,
      skip: 2,
      take: 2,
    });
    expect(ids(page)).toEqual(ids(all).slice(2, 4));
    expect(
      ids(await db.usHit.search({ query: "graph", mode: "terms", indexes: ALL, take: 3 })),
    ).toEqual(ids(all).slice(0, 3));
    const k0 = await db.usHit.search({ query: "graph", mode: "terms", indexes: ALL, rrfK: 0 });
    expect(k0[0]!.$score).toBe(1);
    expect(await db.usHit.search({ query: "  ", indexes: ALL })).toEqual([]);
    expect(await db.usHit.search({ query: "graph", indexes: ALL, take: 0 })).toEqual([]);
  });

  it("filters per member with $on and __typename, and selects per member", async () => {
    const hits = await db.usHit.search({
      query: "graph",
      mode: "terms",
      indexes: ALL,
      where: { $on: { UsArticle: { published: true }, UsAuthor: { name: { startsWith: "Ada" } } } },
      select: { $on: { UsArticle: { title: true, tags: true } } },
    });
    expect(hits).toEqual([
      {
        __typename: "UsArticle",
        title: "Graph databases",
        tags: [{ id: "t1", name: "db" }],
        $score: expect.closeTo(1 / 61, 12),
      },
      { __typename: "UsAuthor", $score: expect.closeTo(1 / 61, 12) },
    ]);
    const editors = await db.usHit.search({
      query: "graph",
      mode: "terms",
      indexes: ALL,
      where: { __typename: "UsEditor" },
    });
    expect(ids(editors)).toEqual(["e1"]);
    // Only the members listed in indexes are searched.
    const articles = await db.usHit.search({
      query: "graph",
      mode: "terms",
      indexes: { UsArticle: "usArticleText" },
    });
    expect(articles.map((h) => h.__typename)).toEqual(["UsArticle", "UsArticle"]);
  });

  it("searches a union with an interface member through the interface's index", async () => {
    const hits = await db.usParty.search({
      query: "graph",
      mode: "terms",
      indexes: { UsPerson: "usPersonAbout", UsAuthor: "usAuthorName" },
    });
    const found = [...ids(hits)].sort();
    // FalkorDB has one full-text index per label: its UsAuthor index also covers bio.
    expect(found).toEqual(onFalkorDB ? ["e1", "r1", "w1", "w2"] : ["e1", "r1", "w1"]);
    expect(new Set(hits.map((h) => h.__typename))).toEqual(
      new Set(["UsEditor", "UsReviewer", "UsAuthor"]),
    );
  });

  it("fuses the members' vector indexes, whatever their similarity function", async () => {
    const hits = await db.usHit.findSimilar({ vector: [1, 0, 0], take: 4, scores: true });
    // Best of each index first (a1, w1, e1: member order), then the next best.
    expect(ids(hits)).toEqual(["a1", "w1", "e1", "a2"]);
    expect(hits[0]!.$scores.usArticleEmbedding).toEqual({
      score: expect.any(Number),
      normalized: 1,
      rank: 1,
    });
    expect(hits[0]!.$scores.usArticleEmbedding!.score).toBeCloseTo(1, 5);
    expect(hits[1]!.$scores.usAuthorEmbedding!.score).toBeCloseTo(1, 5);
    expect(hits[3]!.$score).toBeCloseTo(1 / 62, 12);
    const page = await db.usHit.findSimilar({ vector: [1, 0, 0], skip: 1, take: 2 });
    expect(ids(page)).toEqual(["w1", "e1"]);
    const articles = await db.usHit.findSimilar({
      vector: [1, 0, 0],
      take: 5,
      fields: { UsArticle: "embedding" },
      where: { $on: { UsArticle: { published: true } } },
    });
    expect(ids(articles)).toEqual(["a1", "a3"]);
    const authors = await db.usHit.findSimilar({
      vector: [0, 0, 1],
      take: 1,
      where: { __typename: "UsAuthor" },
      select: { $on: { UsAuthor: { name: true } } },
    });
    expect(authors).toEqual([
      { __typename: "UsAuthor", name: "Ada", $score: expect.closeTo(1 / 61, 12) },
    ]);
  });

  it("rejects what a union search cannot do", async () => {
    await expect(db.usHit.search({ query: "graph" })).rejects.toThrow(
      new CyphraValidationError(
        'UsHit.search: UsAuthor has several @@fulltext indexes (usAuthorName, usAuthorBio); name the one to search in indexes: { UsAuthor: "…" }.',
      ),
    );
    await expect(
      db.usHit.search({
        query: "graph",
        // @ts-expect-error -- not an index of UsArticle
        indexes: { UsArticle: "usAuthorBio" },
      }),
    ).rejects.toThrow(/indexes\.UsArticle: "usAuthorBio" is not a @@fulltext index of UsArticle/);
    await expect(
      // @ts-expect-error -- findSimilar on a union takes take, not k
      db.usHit.findSimilar({ vector: [1, 0, 0], k: 3 }),
    ).rejects.toThrow(/unknown argument "k" \(a union search is paged after fusion/);
    await expect(db.usHit.findSimilar({ vector: [1, 0], take: 3 })).rejects.toThrow(
      CyphraValidationError,
    );
  });
});
