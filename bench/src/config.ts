/** Command-line flags and data sizes of a run. */

export type Sizes = {
  /** User nodes of the social graph. */
  users: number;
  /** FOLLOWS edges per user (distinct targets, no self-follow). */
  followsPerUser: number;
  /** The first `authors` users write `postsPerAuthor` posts each. */
  authors: number;
  postsPerAuthor: number;
  commentsPerPost: number;
  /** Doc nodes with a `Vector(dims)` embedding. */
  docs: number;
  dims: number;
};

export type Timing = {
  /** Minimum measured time per task, in ms (tinybench `time`). */
  time: number;
  /** Minimum measured iterations per task (tinybench `iterations`). */
  iterations: number;
  warmupTime: number;
  warmupIterations: number;
  /**
   * Rounds per scenario: each round measures every contender once (time and iterations above are
   * per round), so background noise on the machine spreads over all contenders.
   */
  rounds: number;
};

export type Config = {
  quick: boolean;
  sizes: Sizes;
  timing: Timing;
  /** Only run scenarios whose id contains one of these strings. */
  only: string[];
  /** Skip the HTTP transport table. */
  http: boolean;
  /** Write results/latest.json and results/RESULTS.md (full runs only, unless --out). */
  out: string | undefined;
  /** Also copy the results to the docs site (full runs into the default directory). */
  publish: boolean;
  neo4j: { boltUri: string; httpUri: string; user: string; password: string; database: string };
};

const FULL_SIZES: Sizes = {
  users: 10_000,
  followsPerUser: 5,
  authors: 2_000,
  postsPerAuthor: 5,
  commentsPerPost: 2,
  docs: 1_000,
  dims: 384,
};

const QUICK_SIZES: Sizes = {
  users: 300,
  followsPerUser: 5,
  authors: 50,
  postsPerAuthor: 5,
  commentsPerPost: 2,
  docs: 50,
  dims: 384,
};

const FULL_TIMING: Timing = {
  time: 1_000,
  iterations: 70,
  warmupTime: 250,
  warmupIterations: 10,
  rounds: 3,
};
const QUICK_TIMING: Timing = {
  time: 0,
  iterations: 5,
  warmupTime: 0,
  warmupIterations: 2,
  rounds: 1,
};

function flag(args: string[], name: string): string | undefined {
  const i = args.findIndex((a) => a === name || a.startsWith(`${name}=`));
  if (i < 0) return undefined;
  const a = args[i]!;
  if (a.includes("=")) return a.slice(a.indexOf("=") + 1);
  const next = args[i + 1];
  return next && !next.startsWith("--") ? next : "";
}

export function parseConfig(args: string[], env: NodeJS.ProcessEnv): Config {
  const quick = args.includes("--quick");
  const only = (flag(args, "--only") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const outFlag = flag(args, "--out");
  const out = outFlag || (quick ? undefined : "results");
  return {
    quick,
    sizes: quick ? QUICK_SIZES : FULL_SIZES,
    timing: quick ? QUICK_TIMING : FULL_TIMING,
    only,
    http: !args.includes("--no-http"),
    out,
    publish: !quick && !outFlag && only.length === 0,
    neo4j: {
      boltUri: env.NEO4J_BENCH_URI ?? env.NEO4J_TEST_URI ?? "bolt://127.0.0.1:17724",
      httpUri: env.NEO4J_BENCH_HTTP_URI ?? env.NEO4J_TEST_HTTP_URI ?? "http://127.0.0.1:17484",
      user: env.NEO4J_BENCH_USER ?? env.NEO4J_TEST_USER ?? "neo4j",
      password: env.NEO4J_BENCH_PASSWORD ?? env.NEO4J_TEST_PASSWORD ?? "cyphra_ci_test",
      database: env.NEO4J_BENCH_DATABASE ?? "neo4j",
    },
  };
}
