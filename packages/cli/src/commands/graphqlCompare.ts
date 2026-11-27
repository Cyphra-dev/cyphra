import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { compat, migrate, native } from "@cyphra/graphql";
import type { GraphQLResultLike, ResultDifference } from "@cyphra/graphql";
import { createOrm } from "@cyphra/runtime";
import { graphql, Kind, parse, type GraphQLSchema, type OperationDefinitionNode } from "graphql";
import neo4j, { type Driver } from "neo4j-driver";
import {
  expandFiles,
  extractDocuments,
  loadMigrationContext,
  locate,
  type MigrationSourceOptions,
} from "./graphqlMigrate.js";
import { assessUri, confirm, decideReset } from "./migrateReset.js";

/** Options of {@link runGraphqlCompare}. */
export type GraphqlCompareOptions = MigrationSourceOptions & {
  /** The `compat.v7` endpoint (with `nativeUrl`: compare over HTTP instead of in-process). */
  readonly v7Url?: string;
  /** The native endpoint. */
  readonly nativeUrl?: string;
  /** HTTP headers sent to both endpoints (`"Authorization: Bearer …"`). */
  readonly header?: readonly string[];
  /** In-process: Cypher statements run after each reset (`;` at the end of a line ends one). */
  readonly seed?: string;
  /**
   * In-process: delete everything and apply `seed` before each run (a disposable database only).
   * Without it, mutations are skipped and reads run on the current data.
   */
  readonly reset?: boolean;
  /** With `reset`: skip the confirmation prompt (non-local URIs are still refused). */
  readonly yes?: boolean;
  /** With `reset`: skip the confirmation prompt and the local-database check. */
  readonly force?: boolean;
  /** Over HTTP: also run mutations (they run twice, once per API, on the same data). */
  readonly allowMutations?: boolean;
  /** A decoded JWT payload (JSON file) for every operation (`NN.jwt.json` next to a file wins). */
  readonly jwt?: string;
  /** More template tags / functions holding documents. */
  readonly tag?: readonly string[];
  /** Compare lists in order. */
  readonly ordered?: boolean;
  readonly json?: boolean;
};

type Run = (input: {
  query: string;
  operationName?: string;
  variables?: Record<string, unknown>;
  jwt?: Record<string, unknown>;
}) => Promise<GraphQLResultLike>;

async function readJson(file: string): Promise<Record<string, unknown> | undefined> {
  if (!existsSync(file)) return undefined;
  return JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
}

function splitStatements(seed: string): string[] {
  return seed
    .split(/;\s*$/m)
    .map((s) =>
      s
        .split("\n")
        .filter((l) => !/^\s*\/\//.test(l))
        .join("\n")
        .trim(),
    )
    .filter(Boolean);
}

function httpRun(url: string, headers: Record<string, string>): Run {
  return async ({ query, operationName, variables, jwt }) => {
    void jwt;
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ query, operationName, variables }),
    });
    return (await res.json()) as GraphQLResultLike;
  };
}

function schemaRun(schema: GraphQLSchema): Run {
  return async ({ query, operationName, variables, jwt }) => {
    const r = await graphql({
      schema,
      source: query,
      operationName,
      variableValues: variables,
      contextValue: jwt ? { jwt } : {},
    });
    return JSON.parse(JSON.stringify(r)) as GraphQLResultLike;
  };
}

/** What {@link runGraphqlCompare} uses from its environment (replaced in tests). */
export type GraphqlCompareDeps = {
  /** Whether stdin and stdout are terminals (default: detected). */
  readonly interactive?: boolean;
  /** Ask a yes/no question (default: on the terminal). */
  readonly confirm?: (question: string) => Promise<boolean>;
  /** Open the driver (default: `neo4j.driver(uri, basic auth)`). */
  readonly driver?: (uri: string, user: string, password: string) => Driver;
};

/** One operation of the report. */
type ReportOperation = {
  location: string;
  operation: string;
  status: "same" | "known" | "differs" | "not translated" | "skipped";
  differences: ResultDifference[];
  reason?: string;
};

/**
 * `cyphra graphql compare <files…>`: run each v7 operation against `compat.v7` and its
 * translation (the codemod's, in memory) against the native API, map the v7 result to the native
 * shape and report the differences, operation by operation. In-process (the type definitions,
 * `schema.cyphra` and config, on the database of `NEO4J_URI`), or over HTTP (`--v7-url` and
 * `--native-url`). Differences the native API has on purpose (cursors, `connect` as a MERGE) are
 * reported as known, not as failures.
 *
 * @returns The exit code: `1` when an operation's results differ (other than known differences).
 */
export async function runGraphqlCompare(
  cwd: string,
  patterns: readonly string[],
  opts: GraphqlCompareOptions = {},
  deps: GraphqlCompareDeps = {},
): Promise<number> {
  const { ctx, typeDefs } = await loadMigrationContext(cwd, opts);
  const files = await expandFiles(cwd, patterns);
  const tags = (opts.tag ?? []).flatMap((t) => t.split(",")).filter(Boolean);
  const http = opts.v7Url !== undefined || opts.nativeUrl !== undefined;
  if (http && (!opts.v7Url || !opts.nativeUrl)) {
    console.error("Give both endpoints: --v7-url and --native-url.");
    return 1;
  }
  const globalJwt = opts.jwt ? await readJson(path.resolve(cwd, opts.jwt)) : undefined;
  const seed = opts.seed
    ? splitStatements(await readFile(path.resolve(cwd, opts.seed), "utf8"))
    : [];
  if (opts.seed && !opts.reset) {
    console.error(
      "--seed is applied after each reset: pass --reset too (it deletes every node: a disposable database only).",
    );
    return 1;
  }

  let driver: Driver | undefined;
  let runV7: Run;
  let runNative: Run;
  let reset: (() => Promise<void>) | undefined;
  if (http) {
    const headers = Object.fromEntries(
      (opts.header ?? []).map((h) => {
        const i = h.indexOf(":");
        return [h.slice(0, i).trim(), h.slice(i + 1).trim()];
      }),
    );
    runV7 = httpRun(opts.v7Url!, headers);
    runNative = httpRun(opts.nativeUrl!, headers);
  } else {
    const uri = process.env.NEO4J_URI;
    const user = process.env.NEO4J_USERNAME || process.env.NEO4J_USER;
    const password = process.env.NEO4J_PASSWORD;
    if (!uri || !user || !password) {
      console.error(
        "Set NEO4J_URI, NEO4J_USERNAME and NEO4J_PASSWORD (or compare over HTTP with --v7-url and --native-url).",
      );
      return 1;
    }
    const database = process.env.NEO4J_DATABASE;
    if (opts.reset) {
      // `--reset` deletes every node: the same safety check as `cyphra migrate reset`.
      const interactive = deps.interactive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
      const decision = decideReset(uri, opts, interactive);
      if (decision.action === "refuse") {
        console.error(decision.message);
        return 1;
      }
      if (decision.action === "prompt") {
        const ask = deps.confirm ?? ((q: string) => confirm(q));
        const ok = await ask(
          `Reset ${database || "the default database"} on ${assessUri(uri).host || uri} before each operation? All its nodes will be deleted.`,
        );
        if (!ok) {
          console.error("Compare cancelled.");
          return 1;
        }
      }
    }
    driver = deps.driver
      ? deps.driver(uri, user, password)
      : neo4j.driver(uri, neo4j.auth.basic(user, password));
    const v7 = compat.v7.makeSchema({
      typeDefs: typeDefs.map((t) => t.body).join("\n"),
      driver,
      ...(database ? { database } : {}),
    });
    const db = createOrm(ctx.model, { driver, ...(database ? { database } : {}) });
    const api = native.makeSchema({ client: db, config: ctx.config });
    runV7 = schemaRun(v7);
    runNative = schemaRun(api);
    if (opts.reset) {
      reset = async () => {
        await driver!.executeQuery("MATCH (n) DETACH DELETE n", {}, database ? { database } : {});
        for (const s of seed) await driver!.executeQuery(s, {}, database ? { database } : {});
      };
    }
  }

  const report: ReportOperation[] = [];
  try {
    for (const abs of files) {
      const file = path.relative(cwd, abs) || abs;
      const text = await readFile(abs, "utf8");
      const base = abs.replace(/\.(graphql|gql)$/, "");
      const isGraphqlFile = base !== abs;
      const variables = isGraphqlFile ? await readJson(`${base}.variables.json`) : undefined;
      const jwt = (isGraphqlFile ? await readJson(`${base}.jwt.json`) : undefined) ?? globalJwt;
      for (const d of extractDocuments(abs, text, tags)) {
        if (d.skipped || !d.text.trim()) continue;
        const t = migrate.translateDocument(ctx, d.text, { comments: false });
        if (t.status === "native") continue;
        if (t.status === "invalid") {
          report.push({
            location: locate(file, text, d.start),
            operation: "(document)",
            status: "not translated",
            differences: [],
            reason: t.issues[0]?.message,
          });
          continue;
        }
        const source = parse(d.text);
        for (const def of t.definitions) {
          if (def.kind !== "operation") continue;
          const op = source.definitions.find(
            (x): x is OperationDefinitionNode =>
              x.kind === Kind.OPERATION_DEFINITION && x.loc?.start === def.loc,
          )!;
          const location = locate(file, text, d.start + def.loc);
          const name = def.name ?? `(anonymous ${op.operation})`;
          if (t.status === "blocked") {
            report.push({
              location,
              operation: name,
              status: "not translated",
              differences: [],
              reason: def.issues.find((i) => i.kind === "blocking")?.message,
            });
            continue;
          }
          if (op.operation === "subscription") continue;
          if (op.operation === "mutation" && (http ? !opts.allowMutations : !opts.reset)) {
            report.push({
              location,
              operation: name,
              status: "skipped",
              differences: [],
              reason: http
                ? "a mutation (pass --allow-mutations)"
                : "a mutation (pass --reset on a disposable database)",
            });
            continue;
          }
          const input = { operationName: def.name, variables, jwt };
          if (reset) await reset();
          const v7Result = await runV7({ ...input, query: d.text });
          if (reset) await reset();
          const nativeResult = await runNative({ ...input, query: t.output });
          const differences = migrate.compareResults(def, v7Result, nativeResult, {
            ordered: opts.ordered,
          });
          const failing = differences.filter((x) => !x.known);
          report.push({
            location,
            operation: name,
            status: failing.length ? "differs" : differences.length ? "known" : "same",
            differences,
          });
        }
      }
    }
  } finally {
    await driver?.close();
  }

  const count = (s: ReportOperation["status"]) => report.filter((r) => r.status === s).length;
  if (opts.json) {
    console.log(
      JSON.stringify(
        { operations: report },
        (_, v) => (v instanceof migrate.Unmapped ? `<${v.reason}>` : v),
        2,
      ),
    );
  } else {
    const LABEL: Record<ReportOperation["status"], string> = {
      same: "same",
      known: "same (known differences)",
      differs: "DIFFERS",
      "not translated": "not translated",
      skipped: "skipped",
    };
    for (const r of report) {
      console.log(
        `${r.location}  ${LABEL[r.status]}  ${r.operation}${r.reason ? `: ${r.reason}` : ""}`,
      );
      for (const x of r.differences) {
        const show = (v: unknown) => JSON.stringify(v) ?? "undefined";
        console.log(
          `  ${x.path}: v7 ${x.known && x.v7 === undefined ? "(not comparable)" : show(x.v7)}, native ${show(x.native)}${x.known ? ` (known: ${x.known})` : ""}`,
        );
      }
    }
    console.log(
      `\n${report.length} operation${report.length === 1 ? "" : "s"}: ${count("same") + count("known")} same${count("known") ? ` (${count("known")} with known differences)` : ""}, ${count("differs")} differ, ${count("not translated")} not translated, ${count("skipped")} skipped.`,
    );
  }
  return count("differs") ? 1 : 0;
}
