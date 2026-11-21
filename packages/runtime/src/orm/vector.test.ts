import neo4j from "neo4j-driver";
import { describe, expect, it } from "vitest";
import { schemaModel } from "./__fixtures__/vector.gen.js";
import { ModelEngine, type Executor, type Runner } from "./engine.js";
import { CyphraValidationError } from "./errors.js";

type Call = { text: string; params: Record<string, unknown> };

function engine(answer: (call: Call) => Record<string, unknown>[]) {
  const calls: Call[] = [];
  const exec: Executor = async (text, params) => {
    const call = { text, params };
    calls.push(call);
    return answer(call);
  };
  const runner: Runner = { read: (fn) => fn(exec), write: (fn) => fn(exec) };
  const model = schemaModel.nodes.find((n) => n.name === "VecChunk")!;
  return { calls, e: new ModelEngine(schemaModel, model, runner) };
}

const row = (id: string) => ({
  id,
  text: id,
  position: neo4j.int(0),
  embedding: [1, 0, 0],
  sketch: null,
  raw: null,
});

const projection = "n{.`id`, .`text`, .`position`, .`embedding`, .`sketch`, .`raw`}";

describe("findSimilar", () => {
  it("queries the vector index once without a filter", async () => {
    const { calls, e } = engine(() => [
      { row: row("b"), score: 0.8 },
      { row: row("a"), score: 0.9 },
    ]);
    const out = await e.findSimilar({ field: "embedding", vector: [1, 0, 0], k: 2 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.text).toBe(
      "CALL db.index.vector.queryNodes($p2, $p3, $p0) YIELD node, score WITH node AS n, score" +
        ` WITH n, score ORDER BY score DESC LIMIT $p1 RETURN ${projection} AS row, score ORDER BY score DESC`,
    );
    expect(calls[0]!.params).toMatchObject({
      p0: [1, 0, 0],
      p1: neo4j.int(2),
      p2: "VecChunk_embedding_vector",
      p3: neo4j.int(2),
    });
    // Best first, with $score and decoded scalars.
    expect(out.map((r) => [r.id, r.$score, r.position])).toEqual([
      ["a", 0.9, 0],
      ["b", 0.8, 0],
    ]);
  });

  it("over-fetches, filters in the statement and widens until k rows match", async () => {
    const asked: number[] = [];
    const { calls, e } = engine(({ params }) => {
      const n = (params.cyphraCandidates as ReturnType<typeof neo4j.int>).toNumber();
      asked.push(n);
      // The index holds 1000 nodes; only the 1600-candidate attempt finds 2 matches.
      const fetched = Math.min(n, 1000);
      const rows =
        n >= 1000
          ? [
              { row: row("x"), score: 0.7 },
              { row: row("y"), score: 0.6 },
            ]
          : [];
      return [{ fetched: neo4j.int(fetched), lowest: 0.1, rows }];
    });
    const out = await e.findSimilar({
      field: "embedding",
      vector: [1, 0, 0],
      k: 2,
      where: { text: "t" },
      minScore: 0.05,
    });
    expect(asked).toEqual([100, 400, 1600]);
    expect(out.map((r) => r.id)).toEqual(["x", "y"]);
    expect(calls[0]!.text).toContain(
      "CALL db.index.vector.queryNodes($p4, $cyphraCandidates, $p1) YIELD node, score WITH collect({n: node, s: score}) AS hits" +
        " CALL { WITH hits UNWIND hits AS h WITH h.n AS n, h.s AS score WHERE score >= $p3 AND n.`text` = $p0",
    );
    expect(calls[0]!.text).toContain("RETURN size(hits) AS fetched, hits[-1].s AS lowest, rows");
  });

  it("stops widening when the index is exhausted, scores drop below minScore, or at maxCandidates", async () => {
    const run = async (
      args: Record<string, unknown>,
      answer: (n: number) => { fetched: number; lowest: number | null },
    ) => {
      const asked: number[] = [];
      const { e } = engine(({ params }) => {
        const n = (params.cyphraCandidates as ReturnType<typeof neo4j.int>).toNumber();
        asked.push(n);
        const a = answer(n);
        return [{ fetched: neo4j.int(a.fetched), lowest: a.lowest, rows: [] }];
      });
      const out = await e.findSimilar({
        field: "embedding",
        vector: [1, 0, 0],
        k: 5,
        where: { text: "t" },
        ...args,
      });
      expect(out).toEqual([]);
      return asked;
    };
    expect(await run({}, (n) => ({ fetched: Math.min(n, 150), lowest: 0.5 }))).toEqual([100, 400]);
    expect(await run({ minScore: 0.6 }, (n) => ({ fetched: n, lowest: 0.5 }))).toEqual([100]);
    expect(
      await run({ candidates: 10, maxCandidates: 100 }, (n) => ({ fetched: n, lowest: 0.5 })),
    ).toEqual([10, 40, 100]);
  });

  it("exact: true ranks the filtered nodes with vector.similarity.*", async () => {
    const { calls, e } = engine(() => []);
    await e.findSimilar({
      field: "sketch",
      vector: [0, 0],
      k: 3,
      exact: true,
      where: { text: "t" },
    });
    expect(calls[0]!.text).toBe(
      "MATCH (n:`VecChunk`) WHERE n.`sketch` IS NOT NULL AND size(n.`sketch`) = $p3 AND (n.`text` = $p0)" +
        " WITH n, vector.similarity.euclidean(n.`sketch`, $p1) AS score" +
        ` WITH n, score ORDER BY score DESC LIMIT $p2 RETURN ${projection} AS row, score ORDER BY score DESC`,
    );
  });

  it("validates its arguments", async () => {
    const { e, calls } = engine(() => []);
    const base = { field: "embedding", vector: [1, 0, 0], k: 1 };
    const fails = (args: Record<string, unknown>, msg: RegExp) =>
      expect(e.findSimilar({ ...base, ...args })).rejects.toThrow(msg);
    await fails({ vector: [1, 0] }, /expected a vector of 3 dimensions, got 2/);
    await fails({ vector: [1, 0, Number.POSITIVE_INFINITY] }, /finite number/);
    await fails({ vector: "nope" }, /expected a vector/);
    await fails({ field: "raw" }, /no @vectorIndex/);
    await fails({ field: "text" }, /not a Vector field/);
    await fails({ field: undefined }, /field is required \(embedding, sketch\)/);
    await fails({ k: 1.5 }, /k must be a positive integer/);
    await fails({ k: undefined }, /k is required/);
    await fails({ candidates: 0 }, /candidates must be a positive integer/);
    await fails({ k: 5, candidates: 2 }, /candidates must be at least k/);
    await fails({ candidates: 10, maxCandidates: 5 }, /maxCandidates must be at least/);
    await fails({ minScore: "high" }, /minScore must be a finite number/);
    await fails({ orderBy: { id: "asc" } }, /unknown argument "orderBy"/);
    await expect(e.findSimilar({ ...base, vector: [1, 0] })).rejects.toBeInstanceOf(
      CyphraValidationError,
    );
    expect(calls).toHaveLength(0);
  });

  it("accepts typed arrays as query vectors", async () => {
    const { calls, e } = engine(() => []);
    await e.findSimilar({ field: "embedding", vector: new Float32Array([1, 0, 0]), k: 1 });
    expect(calls[0]!.params.p0).toEqual([1, 0, 0]);
  });
});

describe("vector fields in other operations", () => {
  it("only filters vectors on null and refuses to sort them", async () => {
    const { calls, e } = engine(() => []);
    await e.findMany({ where: { embedding: null, sketch: { not: null } } });
    expect(calls[0]!.text).toContain("WHERE (n.`embedding` IS NULL) AND (n.`sketch` IS NOT NULL)");
    await expect(e.findMany({ where: { embedding: [1, 0, 0] } })).rejects.toThrow(
      /can only be filtered on null/,
    );
    await expect(e.findMany({ where: { embedding: { has: 1 } } })).rejects.toThrow(
      /can only be filtered on null/,
    );
    await expect(e.findMany({ orderBy: { embedding: "asc" } })).rejects.toThrow(/cannot be sorted/);
  });

  it("checks vector length on create and update", async () => {
    const { calls, e } = engine(() => [{ id: "4:x:0", row: row("a") }]);
    await expect(
      e.create({ data: { id: "a", text: "a", position: 0, embedding: [1, 0] } }),
    ).rejects.toThrow(/VecChunk\.embedding: expected a vector of 3 dimensions, got 2/);
    await expect(e.update({ where: { id: "a" }, data: { sketch: [1, "2"] } })).rejects.toThrow(
      /VecChunk\.sketch\[1\]: expected a finite number/,
    );
    expect(calls.filter((c) => /CREATE|SET/.test(c.text))).toEqual([]);
    calls.length = 0;
    await e.create({ data: { id: "a", text: "a", position: 0, embedding: [1, 0, 0] } });
    expect(calls[0]!.params.p0).toMatchObject({ embedding: [1, 0, 0] });
  });
});
