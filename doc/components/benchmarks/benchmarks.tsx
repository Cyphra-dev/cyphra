// The /benchmarks page: tables and a chart rendered at build time from app/benchmarks/results.json
// (written by `pnpm bench` in bench/). Server components only: no client JavaScript.
import type { ReactNode } from "react";
import { Table } from "nextra/components";
import styles from "./benchmarks.module.css";

type Stats = {
  median: number;
  p95: number;
  mean: number;
  rme: number;
  opsPerSec: number;
  samples: number;
};

type Contender =
  | "neo4j-driver"
  | "cyphra"
  | "neogma"
  | "query-api"
  | "cyphra-http"
  | "neo4j-graphql"
  | "cyphra-graphql";

type Scenario = {
  id: string;
  title: string;
  description: string;
  results: Partial<Record<Contender, Stats>>;
  na: Partial<Record<string, string>>;
};

export type BenchResults = {
  date: string;
  environment: {
    cpu: string;
    cores: number;
    memoryGb: number;
    os: string;
    arch: string;
    node: string;
    neo4j: string;
    commit?: string;
    packages: Record<string, string>;
  };
  data: Record<string, number>;
  timing: {
    time: number;
    iterations: number;
    warmupTime: number;
    warmupIterations: number;
    rounds: number;
  };
  scenarios: Scenario[];
};

const LABEL: Record<Contender, string> = {
  "neo4j-driver": "neo4j-driver",
  cyphra: "Cyphra",
  neogma: "neogma",
  "query-api": "Query API (fetch)",
  "cyphra-http": "Cyphra HTTP",
  "neo4j-graphql": "@neo4j/graphql",
  "cyphra-graphql": "@cyphra/graphql",
};

function ms(x: number | undefined): string {
  if (x === undefined) return "n/a";
  return x < 10 ? `${x.toFixed(2)} ms` : `${x.toFixed(1)} ms`;
}

function overhead(s: Stats | undefined, base: Stats | undefined): number | undefined {
  return s && base ? (s.median / base.median - 1) * 100 : undefined;
}

function pct(x: number | undefined): string {
  if (x === undefined) return "n/a";
  const r = Math.round(x);
  return r === 0 ? "0%" : `${r > 0 ? "+" : "−"}${Math.abs(r)}%`;
}

function Grid({ head, rows }: { head: string[]; rows: { key: string; cells: ReactNode[] }[] }) {
  return (
    <Table className={`nextra-scrollbar ${styles.table}`}>
      <thead>
        <Table.Tr>
          {head.map((h, i) => (
            <Table.Th key={h} className={i === 0 ? undefined : styles.num}>
              {h}
            </Table.Th>
          ))}
        </Table.Tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <Table.Tr key={r.key}>
            {r.cells.map((c, i) => (
              <Table.Td key={i} className={i === 0 ? undefined : styles.num}>
                {c ?? "n/a"}
              </Table.Td>
            ))}
          </Table.Tr>
        ))}
      </tbody>
    </Table>
  );
}

const cell = (s: Stats | undefined): ReactNode =>
  s ? (
    <>
      {ms(s.median)}
      <span className={styles.p95}>p95 {ms(s.p95)}</span>
    </>
  ) : undefined;

/** Cyphra and neogma against the raw driver, over Bolt. */
export function BoltTable({ results }: { results: BenchResults }) {
  return (
    <Grid
      head={[
        "Scenario",
        "neo4j-driver",
        "Cyphra",
        "Cyphra vs driver",
        "neogma",
        "neogma vs driver",
      ]}
      rows={results.scenarios.map((s) => {
        const base = s.results["neo4j-driver"];
        return {
          key: s.id,
          cells: [
            s.title,
            cell(base),
            cell(s.results.cyphra),
            pct(overhead(s.results.cyphra, base)),
            cell(s.results.neogma),
            pct(overhead(s.results.neogma, base)),
          ],
        };
      })}
    />
  );
}

export function HttpTable({ results }: { results: BenchResults }) {
  return (
    <Grid
      head={["Scenario", "Query API (fetch)", "Cyphra HTTP", "vs fetch", "vs Bolt driver"]}
      rows={results.scenarios
        .filter((s) => s.results["cyphra-http"])
        .map((s) => ({
          key: s.id,
          cells: [
            s.title,
            cell(s.results["query-api"]),
            cell(s.results["cyphra-http"]),
            pct(overhead(s.results["cyphra-http"], s.results["query-api"])),
            pct(overhead(s.results["cyphra-http"], s.results["neo4j-driver"])),
          ],
        }))}
    />
  );
}

export function GraphqlTable({ results }: { results: BenchResults }) {
  return (
    <Grid
      head={["Scenario", "neo4j-driver", "@neo4j/graphql", "@cyphra/graphql", "@cyphra vs @neo4j"]}
      rows={results.scenarios
        .filter((s) => s.results["neo4j-graphql"] || s.results["cyphra-graphql"])
        .map((s) => ({
          key: s.id,
          cells: [
            s.title,
            cell(s.results["neo4j-driver"]),
            cell(s.results["neo4j-graphql"]),
            cell(s.results["cyphra-graphql"]),
            pct(overhead(s.results["cyphra-graphql"], s.results["neo4j-graphql"])),
          ],
        }))}
    />
  );
}

/** Every number: median, p95, mean ± margin of error, ops/s and sample count. */
export function DetailTable({ results }: { results: BenchResults }) {
  return (
    <Grid
      head={["Scenario", "Contender", "median", "p95", "mean", "ops/s", "samples"]}
      rows={results.scenarios.flatMap((s) =>
        (Object.entries(s.results) as [Contender, Stats][]).map(([id, st]) => ({
          key: `${s.id}-${id}`,
          cells: [
            s.title,
            LABEL[id],
            ms(st.median),
            ms(st.p95),
            `${ms(st.mean)} ±${st.rme.toFixed(1)}%`,
            Math.round(st.opsPerSec).toLocaleString("en-US"),
            String(st.samples),
          ],
        })),
      )}
    />
  );
}

export function NotCompared({ results }: { results: BenchResults }) {
  const items = results.scenarios.flatMap((s) =>
    Object.entries(s.na).map(([who, why]) => ({
      key: `${s.id}-${who}`,
      text: `${s.title}, ${who === "graphql" ? "GraphQL libraries" : who}: ${why}`,
    })),
  );
  return (
    <ul className={styles.list}>
      {items.map((i) => (
        <li key={i.key}>{i.text}</li>
      ))}
    </ul>
  );
}

export function Environment({ results }: { results: BenchResults }) {
  const e = results.environment;
  const p = e.packages;
  const t = results.timing;
  const rows: [string, string][] = [
    ["Run", `${results.date.slice(0, 10)}${e.commit ? `, commit ${e.commit}` : ""}`],
    ["CPU", `${e.cpu}, ${e.cores} logical cores`],
    ["Memory", `${e.memoryGb} GB`],
    ["OS", `${e.os}, ${e.arch}`],
    ["Runtime", `Node.js ${e.node}`],
    ["Database", `Neo4j ${e.neo4j} in Docker on the same machine (loopback), data on tmpfs`],
    [
      "Libraries",
      `neo4j-driver ${p["neo4j-driver"]}, cyphra ${p.cyphra}, @cyphra/graphql ${p["@cyphra/graphql"]}, @neo4j/graphql ${p["@neo4j/graphql"]}, neogma ${p.neogma}, graphql ${p.graphql}`,
    ],
    [
      "Data",
      Object.entries(results.data)
        .map(([k, v]) => `${v.toLocaleString("en-US")} ${k}`)
        .join(", "),
    ],
    [
      "Timing",
      `tinybench ${p.tinybench}; ${t.rounds} interleaved rounds, each with ${t.warmupIterations} warm-up iterations then at least ${t.iterations} iterations and ${t.time / 1000} s per contender`,
    ],
  ];
  return (
    <dl className={styles.env}>
      {rows.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * Median overhead against the raw driver, per scenario: a diverging bar chart around 0%, one row
 * per scenario with a bar for Cyphra and one for neogma (when it has an API for the scenario).
 * Values past the axis are cut and marked; the exact numbers are in the table above.
 */
export function OverheadChart({ results }: { results: BenchResults }) {
  const rows = results.scenarios.map((s) => {
    const base = s.results["neo4j-driver"];
    return {
      id: s.id,
      title: s.title,
      cyphra: overhead(s.results.cyphra, base),
      neogma: overhead(s.results.neogma, base),
    };
  });
  const values = rows.flatMap((r) => [r.cyphra, r.neogma]).filter((v) => v !== undefined);
  const step = 25;
  const lo = Math.min(-step, Math.floor(Math.min(...values) / step) * step);
  const hi = Math.min(200, Math.max(step, Math.ceil(Math.max(...values) / step) * step));

  const W = 640;
  const padL = 48;
  const padR = 56;
  const rowH = 46;
  const top = 36;
  const H = top + rows.length * rowH + 8;
  const x = (v: number) =>
    padL + ((Math.max(lo, Math.min(hi, v)) - lo) / (hi - lo)) * (W - padL - padR);
  const ticks: number[] = [];
  for (let v = lo; v <= hi; v += step * (hi - lo > 150 ? 2 : 1)) ticks.push(v);
  if (!ticks.includes(0)) ticks.push(0);

  const bar = (v: number | undefined, y: number, cls: string) => {
    if (v === undefined) return null;
    const x0 = x(0);
    const x1 = x(v);
    const left = Math.min(x0, x1);
    const w = Math.max(2, Math.abs(x1 - x0));
    const cut = v > hi || v < lo;
    const labelX = v >= 0 ? left + w + 4 : left - 4;
    return (
      <g>
        <rect x={left} y={y} width={w} height={9} rx={2} className={cls} />
        {cut ? (
          <path
            d={
              v > 0 ? `M${left + w - 4} ${y - 2}l6 6.5-6 6.5` : `M${left + 4} ${y - 2}l-6 6.5 6 6.5`
            }
            className={styles.cut}
          />
        ) : null}
        <text x={labelX} y={y + 8} textAnchor={v >= 0 ? "start" : "end"} className={styles.value}>
          {pct(v)}
        </text>
      </g>
    );
  };

  return (
    <figure className={styles.figure}>
      <div className={styles.legend} aria-hidden="true">
        <span>
          <i className={styles.swatchCyphra} /> Cyphra
        </span>
        <span>
          <i className={styles.swatchNeogma} /> neogma
        </span>
      </div>
      <div className={styles.scroll}>
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className={styles.chart}
          role="img"
          aria-label="Median latency overhead of Cyphra and neogma against the raw neo4j-driver, per scenario. The numbers are in the table above."
        >
          {ticks.map((t) => (
            <g key={t}>
              <line
                x1={x(t)}
                x2={x(t)}
                y1={top - 8}
                y2={H - 8}
                className={t === 0 ? styles.zero : styles.grid}
              />
              <text x={x(t)} y={top - 14} textAnchor="middle" className={styles.tick}>
                {t === 0 ? "driver" : pct(t)}
              </text>
            </g>
          ))}
          {rows.map((r, i) => {
            const y = top + i * rowH;
            return (
              <g key={r.id}>
                <text x={0} y={y + 12} className={styles.rowLabel}>
                  {r.title}
                </text>
                {bar(r.cyphra, y + 18, styles.barCyphra)}
                {bar(r.neogma, y + 29, styles.barNeogma)}
              </g>
            );
          })}
        </svg>
      </div>
      <figcaption className={styles.caption}>
        Median latency against the raw driver running hand-written Cypher (the vertical line). Left
        of it is faster, right is slower. Bars past {pct(hi)} are cut.
      </figcaption>
    </figure>
  );
}
