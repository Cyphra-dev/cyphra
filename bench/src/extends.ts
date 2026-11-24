/**
 * Per-request client cost: what `db.$extends(…)` and `withEngineRules(db, …)` cost when a server
 * builds a client per request (the native GraphQL API's `client: (ctx) => db.$extends(…)`), and
 * what an operation through such a client adds. No database: the driver is an in-memory stub
 * answering one canned row, so only Cyphra's client-side work is timed.
 *
 *   pnpm --filter cyphra-bench run extends
 */
import { Bench } from "tinybench";
import { createOrm, parseSchema, resolveSchema, withEngineRules, type DriverLike } from "cyphra";
import { createClient } from "./cyphra.gen.js";

type Row = Record<string, unknown>;

/** A driver whose every statement returns `row` (as `row`). */
function stubDriver(row: Row): DriverLike {
  const run = async () => ({
    records: [{ toObject: () => ({ row }), get: (k: string) => (k === "row" ? row : undefined) }],
    summary: { server: { address: "stub:7687" }, database: { name: "neo4j" } },
  });
  const tx = { run };
  return {
    session: () => ({
      run,
      executeRead: async (work) => work(tx),
      executeWrite: async (work) => work(tx),
      close: async () => {},
    }),
    close: async () => {},
  } as DriverLike;
}

const user: Row = { id: "u1", email: "a@x.io", name: "Ada", age: 36, createdAt: null };

/** A schema of `n` models (`M0` … `Mn-1`), each with a few fields and a relation to the next. */
function wideSchema(n: number) {
  const nodes = Array.from(
    { length: n },
    (_, i) => `node M${i} {
  id    String @id
  name  String
  count Int?
  next  M${(i + 1) % n}[] @relationship(type: "NEXT_${i}", direction: OUT)
}`,
  );
  return resolveSchema(parseSchema(nodes.join("\n\n")));
}

/** Requests seen per tenant, so that the hook below does some per-request work. */
const seen = new Map<string, number>();

async function main() {
  const time = Number(process.env.BENCH_TIME_MS ?? 1000);
  const db = createClient({ driver: stubDriver(user) });
  const wide = createOrm(wideSchema(100), { driver: stubDriver({ id: "x", name: "n" }) });
  type Wide = { m0: { findUnique(args: unknown): Promise<unknown> } };
  const rules = { User: { read: { email: { endsWith: "@x.io" } } } };

  // A query hook of the kind a per-request extension adds (tenant bookkeeping around each call).
  const scoped = (tenant: string) =>
    db.$extends({
      query: {
        $allModels: {
          $allOperations({ args, query }) {
            seen.set(tenant, (seen.get(tenant) ?? 0) + 1);
            return query(args);
          },
        },
      },
    });
  const wideScoped = (tenant: string) =>
    wide.$extends({
      query: {
        $allModels: {
          $allOperations({ args, query }) {
            seen.set(tenant, (seen.get(tenant) ?? 0) + 1);
            return query(args);
          },
        },
      },
    }) as unknown as Wide;

  const bench = new Bench({ time, warmup: true, warmupTime: 250 });
  let tenant = 0;
  const next = () => `t${tenant++ % 1000}`;
  bench
    .add("findUnique (base client, 4 models)", async () => {
      await db.user.findUnique({ where: { id: "u1" } });
    })
    .add("$extends (4 models)", () => {
      scoped(next());
    })
    .add("$extends + findUnique (4 models)", async () => {
      const x = scoped(next());
      await x.user.findUnique({ where: { id: "u1" } });
    })
    .add("withEngineRules (4 models)", () => {
      withEngineRules(db, rules);
    })
    .add("withEngineRules + findUnique (4 models)", async () => {
      await withEngineRules(db, rules).user.findUnique({ where: { id: "u1" } });
    })
    .add("findUnique (base client, 100 models)", async () => {
      await (wide as unknown as Wide).m0.findUnique({ where: { id: "x" } });
    })
    .add("$extends (100 models)", () => {
      wideScoped(next());
    })
    .add("$extends + findUnique (100 models)", async () => {
      const x = wideScoped(next());
      await x.m0.findUnique({ where: { id: "x" } });
    });
  await bench.run();

  console.log(`Node ${process.version}, ${time} ms per task\n`);
  console.log("| Task | Mean | p99 | ops/s |");
  console.log("| --- | ---: | ---: | ---: |");
  for (const task of bench.tasks) {
    const r = task.result;
    if (!r || r.state !== "completed") {
      console.log(`| ${task.name} | failed | | |`);
      continue;
    }
    const us = (ms: number | undefined) => `${((ms ?? 0) * 1000).toFixed(1)} µs`;
    console.log(
      `| ${task.name} | ${us(r.latency.mean)} | ${us(r.latency.p99)} | ${Math.round(r.throughput.mean).toLocaleString("en-US")} |`,
    );
  }
}

await main();
