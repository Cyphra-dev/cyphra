/**
 * `pnpm bench`: seeds the data set, then measures every scenario for every contender, one
 * contender at a time (sequential calls, one in flight), with tinybench.
 *
 *   pnpm bench                      full run, writes results/latest.json and results/RESULTS.md
 *   pnpm bench --quick              small data, few iterations, writes nothing (CI smoke run)
 *   pnpm bench --only find-unique,create
 *   pnpm bench --no-http            skip the HTTP transport contenders
 *   pnpm bench --out <dir>          where to write the results
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import neo4j, { type Driver } from "neo4j-driver";
import { Bench } from "tinybench";
import { parseConfig, type Config } from "./config.js";
import {
  CONTENDERS,
  cyphraBolt,
  cyphraGraphQL,
  cyphraHttp,
  neo4jGraphQL,
  neogmaModels,
  type ContenderId,
} from "./contenders.js";
import { captureEnvironment } from "./environment.js";
import { boltRunner, httpRunner } from "./raw.js";
import { markdown, ms, overhead, pct, stats, type Results, type Stats } from "./results.js";
import { CLEANUP, SCENARIOS, type Env, type Scenario, type Task } from "./scenarios.js";
import { counts, seed, wipe } from "./seed.js";

type Builders = Partial<Record<ContenderId, (s: Scenario, env: Env) => Task | undefined>>;

/** One tinybench run of one task; returns the latency samples, in ms. */
async function measure(task: Task, cfg: Config, name: string): Promise<number[]> {
  const bench = new Bench({
    name,
    time: cfg.timing.time,
    iterations: cfg.timing.iterations,
    warmupTime: cfg.timing.warmupTime,
    warmupIterations: cfg.timing.warmupIterations,
    warmup: cfg.timing.warmupIterations > 0,
    retainSamples: true,
    throws: true,
  });
  bench.add(name, task.fn, { beforeEach: task.beforeEach, async: true });
  await bench.run();
  const t = bench.tasks[0]!;
  const r = t.result;
  if (r.state !== "completed") throw new Error(`${name}: ${r.state}`);
  return [...(r.latency.samples ?? [])];
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

async function main() {
  const cfg = parseConfig(process.argv.slice(2), process.env);
  const { boltUri, user, password, database } = cfg.neo4j;
  const driver: Driver = neo4j.driver(boltUri, neo4j.auth.basic(user, password));
  await driver.verifyConnectivity({ database });

  const t0 = Date.now();
  console.log(`Seeding (${cfg.quick ? "quick" : "full"} data set) on ${boltUri} ...`);
  const fx = await seed(driver, database, cfg.sizes);
  const data = await counts(driver, database);
  console.log(`Seeded in ${((Date.now() - t0) / 1000).toFixed(1)} s:`, data);

  const raw = boltRunner(driver, database);
  const db = cyphraBolt(driver, cfg);
  const dbHttp = cfg.http ? cyphraHttp(cfg) : undefined;
  const rawHttp = cfg.http
    ? httpRunner({ uri: cfg.neo4j.httpUri, user, password, database })
    : undefined;
  const ogm = neogmaModels(cfg);
  const gqlNeo4j = await neo4jGraphQL(driver, cfg);
  const gqlCyphra = cyphraGraphQL(driver, cfg);

  const builders: Builders = {
    "neo4j-driver": (s, env) => s.raw(raw, env),
    cyphra: (s, env) => s.cyphra?.(db, env),
    neogma: (s, env) => s.neogma?.(ogm, env),
    "neo4j-graphql": (s, env) => s.graphql?.(gqlNeo4j, env),
    "cyphra-graphql": (s, env) => s.graphql?.(gqlCyphra, env),
    ...(rawHttp && dbHttp
      ? {
          "query-api": (s: Scenario, env: Env) => (s.cyphra ? s.raw(rawHttp, env) : undefined),
          "cyphra-http": (s: Scenario, env: Env) => s.cyphra?.(dbHttp, env),
        }
      : {}),
  };

  const scenarios = SCENARIOS.filter(
    (s) => cfg.only.length === 0 || cfg.only.some((o) => s.id.includes(o)),
  );
  const out: Results["scenarios"] = [];
  try {
    for (const s of scenarios) {
      console.log(`\n${s.title}`);
      const results: Partial<Record<ContenderId, Stats>> = {};
      // Build every contender's task once (its counters keep running across rounds), and check
      // its first answer against the baseline's before timing anything.
      const tasks: { id: ContenderId; task: Task; env: Env; samples: number[] }[] = [];
      let baseline: unknown;
      for (const [id, build] of Object.entries(builders) as [
        ContenderId,
        Builders[ContenderId],
      ][]) {
        const env: Env = { fx, prefix: `${s.id}.${id}.`, setup: raw };
        const task = build?.(s, env);
        if (!task) continue;
        try {
          await task.beforeEach?.();
          const first = await task.fn();
          await task.verify?.();
          if (task.summarize) {
            const summary = task.summarize(first);
            if (id === "neo4j-driver") baseline = summary;
            else if (baseline !== undefined && !same(summary, baseline))
              throw new Error(
                `${s.id} ${id}: result differs from the baseline: ${JSON.stringify(summary)} vs ${JSON.stringify(baseline)}`,
              );
          }
        } finally {
          if (s.writes) await raw(CLEANUP, { prefix: env.prefix }, "write");
        }
        tasks.push({ id, task, env, samples: [] });
      }
      for (let round = 0; round < cfg.timing.rounds; round++) {
        // Rotate the order, so no contender always runs first (or right after a write scenario).
        const shift = (round * Math.ceil(tasks.length / cfg.timing.rounds)) % tasks.length;
        for (const t of [...tasks.slice(shift), ...tasks.slice(0, shift)]) {
          try {
            t.samples.push(...(await measure(t.task, cfg, `${s.id} ${t.id}`)));
          } finally {
            if (s.writes) await raw(CLEANUP, { prefix: t.env.prefix }, "write");
          }
        }
      }
      for (const t of tasks) {
        const st = stats(t.samples);
        results[t.id] = st;
        const ov = overhead(st, results["neo4j-driver"]);
        console.log(
          `  ${CONTENDERS[t.id].label.padEnd(28)} median ${ms(st.median).padStart(10)}  p95 ${ms(st.p95).padStart(10)}  ${Math.round(st.opsPerSec).toString().padStart(6)} ops/s  ${t.id === "neo4j-driver" ? "" : pct(ov)}`,
        );
      }
      out.push({
        id: s.id,
        title: s.title,
        description: s.description,
        group: s.group,
        results,
        na: s.na ?? {},
      });
    }
  } finally {
    await db.$disconnect();
    await dbHttp?.$disconnect();
    await ogm.neogma.driver.close();
    await wipe(driver, database);
    await driver.close();
  }

  const environment = await (async () => {
    const d = neo4j.driver(boltUri, neo4j.auth.basic(user, password));
    try {
      return await captureEnvironment(d, database);
    } finally {
      await d.close();
    }
  })();
  const results: Results = {
    version: 1,
    date: new Date().toISOString(),
    quick: cfg.quick,
    environment,
    data,
    timing: cfg.timing,
    scenarios: out,
  };

  if (cfg.out) {
    const dir = path.resolve(cfg.out);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "latest.json"), `${JSON.stringify(results, null, 2)}\n`);
    writeFileSync(path.join(dir, "RESULTS.md"), markdown(results));
    console.log(`\nWrote ${path.relative(process.cwd(), dir)}/latest.json and RESULTS.md`);
    if (cfg.publish) {
      // The docs page (/benchmarks) renders its tables and chart from this copy.
      const docs = new URL("../../doc/app/benchmarks/results.json", import.meta.url);
      mkdirSync(new URL(".", docs), { recursive: true });
      writeFileSync(docs, `${JSON.stringify(results, null, 2)}\n`);
      console.log("Wrote doc/app/benchmarks/results.json");
    }
  }
  console.log(`\nDone in ${((Date.now() - t0) / 1000).toFixed(0)} s.`);
}

// Exit explicitly: @neo4j/graphql leaves a handle open after its import.
main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
