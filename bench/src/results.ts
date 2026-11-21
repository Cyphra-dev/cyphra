/** Results file format, statistics, and the generated markdown tables. */
import type { ContenderId } from "./contenders.js";
import type { Environment } from "./environment.js";

export type Stats = {
  /** Latencies in milliseconds. */
  median: number;
  p95: number;
  mean: number;
  min: number;
  max: number;
  /** Relative margin of error of the mean, in %. */
  rme: number;
  /** 1000 / mean: sequential calls per second (one call in flight). */
  opsPerSec: number;
  samples: number;
};

export type ScenarioResult = {
  id: string;
  title: string;
  description: string;
  group: string;
  results: Partial<Record<ContenderId, Stats>>;
  /** Contenders without an implementation, and why. */
  na: Partial<Record<string, string>>;
};

export type Results = {
  version: 1;
  date: string;
  quick: boolean;
  environment: Environment;
  data: Record<string, number>;
  timing: {
    time: number;
    iterations: number;
    warmupTime: number;
    warmupIterations: number;
    rounds: number;
  };
  scenarios: ScenarioResult[];
};

function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

export function stats(samples: readonly number[]): Stats {
  const sorted = [...samples].sort((a, b) => a - b);
  const n = sorted.length;
  const mean = sorted.reduce((s, x) => s + x, 0) / n;
  const sd = Math.sqrt(sorted.reduce((s, x) => s + (x - mean) ** 2, 0) / Math.max(1, n - 1));
  // 95% margin of error of the mean (normal approximation), relative to the mean.
  const rme = n > 1 ? ((1.96 * sd) / Math.sqrt(n) / mean) * 100 : 0;
  return {
    median: quantile(sorted, 0.5),
    p95: quantile(sorted, 0.95),
    mean,
    min: sorted[0]!,
    max: sorted[sorted.length - 1]!,
    rme,
    opsPerSec: 1000 / mean,
    samples: sorted.length,
  };
}

/** Median overhead of `s` over `base`, in % (positive: slower). */
export function overhead(s: Stats | undefined, base: Stats | undefined): number | undefined {
  if (!s || !base) return undefined;
  return (s.median / base.median - 1) * 100;
}

export const ms = (x: number | undefined) =>
  x === undefined
    ? "n/a"
    : x < 1
      ? `${x.toFixed(3)} ms`
      : x < 10
        ? `${x.toFixed(2)} ms`
        : `${x.toFixed(1)} ms`;

export const pct = (x: number | undefined) =>
  x === undefined ? "n/a" : `${x >= 0 ? "+" : "−"}${Math.abs(x).toFixed(0)}%`;

const ops = (s: Stats | undefined) => (s ? Math.round(s.opsPerSec).toLocaleString("en-US") : "n/a");

const LABELS: Record<ContenderId, string> = {
  "neo4j-driver": "neo4j-driver",
  cyphra: "Cyphra",
  neogma: "neogma",
  "query-api": "Query API (fetch)",
  "cyphra-http": "Cyphra HTTP",
  "neo4j-graphql": "@neo4j/graphql",
  "cyphra-graphql": "@cyphra/graphql",
};

function table(head: string[], rows: string[][], align: ("l" | "r")[]): string {
  const sep = align.map((a) => (a === "r" ? "---:" : "---"));
  return [head, sep, ...rows].map((r) => `| ${r.join(" | ")} |`).join("\n");
}

const cell = (s: Stats | undefined) => (s ? `${ms(s.median)} (p95 ${ms(s.p95)})` : "n/a");

/** The headline table: Cyphra and neogma against the raw driver, over Bolt. */
export function boltTable(r: Results): string {
  return table(
    ["Scenario", "neo4j-driver", "Cyphra", "Cyphra overhead", "neogma", "neogma overhead"],
    r.scenarios.map((s) => {
      const base = s.results["neo4j-driver"];
      return [
        s.title,
        cell(base),
        cell(s.results.cyphra),
        pct(overhead(s.results.cyphra, base)),
        cell(s.results.neogma),
        pct(overhead(s.results.neogma, base)),
      ];
    }),
    ["l", "r", "r", "r", "r", "r"],
  );
}

export function httpTable(r: Results): string | undefined {
  const rows = r.scenarios.filter((s) => s.results["cyphra-http"]);
  if (rows.length === 0) return undefined;
  return table(
    ["Scenario", "Query API (fetch)", "Cyphra HTTP", "overhead vs fetch", "vs raw Bolt"],
    rows.map((s) => [
      s.title,
      cell(s.results["query-api"]),
      cell(s.results["cyphra-http"]),
      pct(overhead(s.results["cyphra-http"], s.results["query-api"])),
      pct(overhead(s.results["cyphra-http"], s.results["neo4j-driver"])),
    ]),
    ["l", "r", "r", "r", "r"],
  );
}

export function graphqlTable(r: Results): string | undefined {
  const rows = r.scenarios.filter((s) => s.results["neo4j-graphql"] || s.results["cyphra-graphql"]);
  if (rows.length === 0) return undefined;
  return table(
    [
      "Scenario",
      "neo4j-driver",
      "@neo4j/graphql",
      "@cyphra/graphql",
      "@cyphra/graphql vs @neo4j/graphql",
    ],
    rows.map((s) => [
      s.title,
      cell(s.results["neo4j-driver"]),
      cell(s.results["neo4j-graphql"]),
      cell(s.results["cyphra-graphql"]),
      pct(overhead(s.results["cyphra-graphql"], s.results["neo4j-graphql"])),
    ]),
    ["l", "r", "r", "r", "r"],
  );
}

/** Every number of every contender. */
export function detailTable(r: Results): string {
  const rows: string[][] = [];
  for (const s of r.scenarios) {
    for (const [id, st] of Object.entries(s.results) as [ContenderId, Stats][]) {
      rows.push([
        s.title,
        LABELS[id],
        ms(st.median),
        ms(st.p95),
        ms(st.mean),
        `±${st.rme.toFixed(1)}%`,
        ops(st),
        String(st.samples),
      ]);
    }
  }
  return table(
    ["Scenario", "Contender", "median", "p95", "mean", "rme", "ops/s", "samples"],
    rows,
    ["l", "l", "r", "r", "r", "r", "r", "r"],
  );
}

export function environmentLines(r: Results): string[] {
  const e = r.environment;
  const p = e.packages;
  return [
    `- Date: ${r.date.slice(0, 10)}${e.commit ? ` (commit \`${e.commit}\`)` : ""}`,
    `- CPU: ${e.cpu}, ${e.cores} logical cores, ${e.memoryGb} GB RAM`,
    `- OS: ${e.os}, ${e.arch}`,
    `- Node.js ${e.node}, Neo4j ${e.neo4j}`,
    `- neo4j-driver ${p["neo4j-driver"]}, cyphra ${p.cyphra}, @cyphra/graphql ${p["@cyphra/graphql"]}, @neo4j/graphql ${p["@neo4j/graphql"]}, neogma ${p.neogma}, graphql ${p.graphql}, tinybench ${p.tinybench}`,
    `- Data: ${Object.entries(r.data)
      .map(([k, v]) => `${v.toLocaleString("en-US")} ${k}`)
      .join(", ")}`,
    `- Timing: ${r.timing.rounds} interleaved rounds per scenario; in each, every contender runs at least ${r.timing.iterations} iterations and ${r.timing.time} ms after ${r.timing.warmupIterations} iterations / ${r.timing.warmupTime} ms of warm-up`,
  ];
}

export function markdown(r: Results): string {
  const http = httpTable(r);
  const gql = graphqlTable(r);
  const na = r.scenarios.flatMap((s) =>
    Object.entries(s.na).map(([k, why]) => `- ${s.title}, ${k}: ${why}`),
  );
  return [
    "# Benchmark results",
    "",
    "Generated by `pnpm bench` from `results/latest.json`. Do not edit. Method and caveats: [README](../README.md).",
    "",
    ...environmentLines(r),
    "",
    "## Typed clients over Bolt",
    "",
    "Median latency (p95 in parentheses) of one call, one call in flight. Overhead is the median against the raw driver running hand-written Cypher.",
    "",
    boltTable(r),
    ...(http
      ? [
          "",
          "## HTTP transport",
          "",
          "Cyphra over the Neo4j Query API against the same Cypher sent with `fetch`.",
          "",
          http,
        ]
      : []),
    ...(gql
      ? [
          "",
          "## GraphQL",
          "",
          "The same operation on the same type definitions; documents are parsed and validated once.",
          "",
          gql,
        ]
      : []),
    "",
    "## Not compared",
    "",
    ...na,
    "",
    "## All numbers",
    "",
    detailTable(r),
    "",
  ].join("\n");
}
