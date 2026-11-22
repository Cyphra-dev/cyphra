import { readFile } from "node:fs/promises";
import path from "node:path";
import { resolveUnderRoot } from "./paths.js";
import type { CyphraDialect } from "@cyphra/runtime";

export type CyphraConfig = {
  readonly schema: string;
  readonly migrations: string;
  /** Absolute path for `cyphra generate` output (default `./cyphra.gen.ts`). */
  readonly generate: string;
  /** Module the generated client imports from (default `"cyphra"`). */
  readonly runtimeImport: string;
  /**
   * Shell command run by `cyphra db seed` and after `cyphra migrate reset` (e.g. `"tsx seed.ts"`),
   * from the project root. Absent when not configured.
   */
  readonly seed?: string;
  /**
   * The zod generator (`"generators": { "zod": { … } }`): `cyphra generate` also writes zod schemas
   * of the models to `output`. Absent when not configured.
   */
  readonly zod?: ZodGeneratorConfig;
  /**
   * The database's Cypher flavour (`"neo4j"`, `"memgraph"` or `"falkordb"`). Decides the DDL
   * `migrate dev`, `migrate diff` and `schema ddl` write, and for `"falkordb"` how commands connect
   * (`FALKORDB_URL` / `FALKORDB_GRAPH`). Unset: Neo4j offline; commands that connect detect Neo4j
   * or Memgraph from the server.
   */
  readonly dialect?: CyphraDialect;
};

/** `"generators": { "zod": { "output", "coerce", "import", "omitGenerated" } }` in `cyphra.json`. */
export type ZodGeneratorConfig = {
  /** Absolute path of the zod schemas module (default `./cyphra.zod.ts`). */
  readonly output: string;
  /** Accept ISO 8601 strings for `DateTime` / `Date` and decimal strings for `BigInt` (default `false`). */
  readonly coerce: boolean;
  /** Module the schemas import `z` from (default `"zod"`). */
  readonly import: string;
  /**
   * Leave generated fields (`@id` with a default, `now()` / `cuid()` / `uuid()` defaults) out of the
   * create and update input schemas (default `false`).
   */
  readonly omitGenerated: boolean;
};

/** Default output of the zod generator, relative to the project root. */
export const DEFAULT_ZOD_OUTPUT = "./cyphra.zod.ts";

function zodConfig(cwd: string, raw: unknown): ZodGeneratorConfig | undefined {
  if (raw === undefined || raw === false) return undefined;
  const o = raw === true ? {} : raw;
  if (!o || typeof o !== "object" || Array.isArray(o)) {
    throw new Error('cyphra.json "generators.zod" must be true or an object');
  }
  const {
    output,
    coerce,
    import: zodImport,
    omitGenerated,
    ...rest
  } = o as Record<string, unknown>;
  const unknown = Object.keys(rest);
  if (unknown.length) {
    throw new Error(
      `cyphra.json "generators.zod": unknown option "${unknown[0]}" (expected output, coerce, import, omitGenerated)`,
    );
  }
  if (output !== undefined && (typeof output !== "string" || output === "")) {
    throw new Error('cyphra.json "generators.zod.output" must be a path string');
  }
  if (coerce !== undefined && typeof coerce !== "boolean") {
    throw new Error('cyphra.json "generators.zod.coerce" must be a boolean');
  }
  if (omitGenerated !== undefined && typeof omitGenerated !== "boolean") {
    throw new Error('cyphra.json "generators.zod.omitGenerated" must be a boolean');
  }
  if (zodImport !== undefined && (typeof zodImport !== "string" || zodImport === "")) {
    throw new Error('cyphra.json "generators.zod.import" must be a module name (e.g. "zod")');
  }
  return {
    output: resolveUnderRoot(cwd, output ?? DEFAULT_ZOD_OUTPUT),
    coerce: coerce ?? false,
    import: zodImport ?? "zod",
    omitGenerated: omitGenerated ?? false,
  };
}

/**
 * Load `cyphra.json` from the working directory.
 *
 * @param cwd - Current working directory (absolute).
 */
export async function loadConfig(cwd: string): Promise<CyphraConfig> {
  const configPath = path.join(cwd, "cyphra.json");
  const raw = await readFile(configPath, "utf8");
  const data = JSON.parse(raw) as unknown;
  if (!data || typeof data !== "object") {
    throw new Error("cyphra.json must be a JSON object");
  }
  const schema = (data as Record<string, unknown>).schema;
  const migrations = (data as Record<string, unknown>).migrations;
  const generateRaw = (data as Record<string, unknown>).generate;
  if (typeof schema !== "string" || typeof migrations !== "string") {
    throw new Error('cyphra.json requires string fields "schema" and "migrations"');
  }
  const generatePath = typeof generateRaw === "string" ? generateRaw : "./cyphra.gen.ts";
  const runtimeImportRaw = (data as Record<string, unknown>).runtimeImport;
  if (runtimeImportRaw !== undefined && typeof runtimeImportRaw !== "string") {
    throw new Error('cyphra.json "runtimeImport" must be a string');
  }
  const seedRaw = (data as Record<string, unknown>).seed;
  if (seedRaw !== undefined && (typeof seedRaw !== "string" || seedRaw.trim() === "")) {
    throw new Error('cyphra.json "seed" must be a non-empty command string (e.g. "tsx seed.ts")');
  }
  const generators = (data as Record<string, unknown>).generators;
  if (generators !== undefined && (!generators || typeof generators !== "object")) {
    throw new Error('cyphra.json "generators" must be an object');
  }
  const zod = zodConfig(cwd, (generators as Record<string, unknown> | undefined)?.zod);
  const dialect = (data as Record<string, unknown>).dialect;
  if (
    dialect !== undefined &&
    dialect !== "neo4j" &&
    dialect !== "memgraph" &&
    dialect !== "falkordb"
  ) {
    throw new Error('cyphra.json "dialect" must be "neo4j", "memgraph" or "falkordb"');
  }
  return {
    schema: resolveUnderRoot(cwd, schema),
    migrations: resolveUnderRoot(cwd, migrations),
    generate: resolveUnderRoot(cwd, generatePath),
    runtimeImport: runtimeImportRaw ?? "cyphra",
    ...(seedRaw !== undefined ? { seed: seedRaw.trim() } : {}),
    ...(zod ? { zod } : {}),
    ...(dialect !== undefined ? { dialect } : {}),
  };
}
