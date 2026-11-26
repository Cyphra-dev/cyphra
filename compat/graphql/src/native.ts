/**
 * The native suite: fixtures written for `native.makeSchema` (`native/fixtures/<app>/`:
 * `schema.cyphra`, optional `config.ts`, `seed.cypher`, `operations/`) and their goldens
 * (`native/golden/<app>/`: the sorted SDL and the normalized result of each operation). There is
 * no reference implementation: goldens are written by the native API itself (`golden:native`)
 * and reviewed, so any change of the printed contract or of a result shows up as a golden diff.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { native, type GraphQLConfig } from "@cyphra/graphql";
import { createOrm } from "@cyphra/runtime";
import { parseSchema, resolveSchema, type SchemaModel } from "@cyphra/schema";
import { execute, parse, validate, type ExecutionResult, type GraphQLSchema } from "graphql";
import type { Driver } from "neo4j-driver";
import { COMPAT_ROOT, loadOperations, type Operation } from "./fixtures.js";
import { normalizeResult, stringifyResult } from "./normalize.js";
import { resetAndSeed } from "./runner.js";

export const NATIVE_FIXTURES_DIR = path.join(COMPAT_ROOT, "native", "fixtures");
export const NATIVE_GOLDEN_DIR = path.join(COMPAT_ROOT, "native", "golden");

export type NativeFixture = {
  name: string;
  dir: string;
  schema: SchemaModel;
  seed: string;
  /** `config.ts` (its default export), when the fixture has one. */
  configPath?: string;
  operations: Operation[];
};

export function loadNativeFixture(name: string): NativeFixture {
  const dir = path.join(NATIVE_FIXTURES_DIR, name);
  const configPath = path.join(dir, "config.ts");
  return {
    name,
    dir,
    schema: resolveSchema(parseSchema(readFileSync(path.join(dir, "schema.cyphra"), "utf8"))),
    seed: readFileSync(path.join(dir, "seed.cypher"), "utf8"),
    configPath: existsSync(configPath) ? configPath : undefined,
    operations: loadOperations(name, path.join(dir, "operations")),
  };
}

export function loadNativeFixtures(only: string[] = []): NativeFixture[] {
  return readdirSync(NATIVE_FIXTURES_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((name) => only.length === 0 || only.includes(name))
    .sort()
    .map(loadNativeFixture);
}

export async function nativeConfig(fixture: NativeFixture): Promise<GraphQLConfig | undefined> {
  if (!fixture.configPath) return undefined;
  const mod = (await import(pathToFileURL(fixture.configPath).href)) as {
    default: GraphQLConfig;
  };
  return mod.default;
}

/** The fixture's sorted SDL (`native.printSchema`), as committed in `schema.graphql`. */
export async function printNativeSchema(fixture: NativeFixture): Promise<string> {
  return native.printSchema(fixture.schema, await nativeConfig(fixture));
}

export async function buildNativeSchema(
  fixture: NativeFixture,
  driver: Driver,
): Promise<GraphQLSchema> {
  return native.makeSchema({
    client: createOrm(fixture.schema, { driver }),
    config: await nativeConfig(fixture),
  });
}

export function nativeGoldenSchemaPath(fixture: string): string {
  return path.join(NATIVE_GOLDEN_DIR, fixture, "schema.graphql");
}

export function nativeGoldenResultPath(fixture: string, operation: string): string {
  return path.join(NATIVE_GOLDEN_DIR, fixture, `${operation}.json`);
}

/** Resets the database, applies the seed, runs one operation and returns normalized JSON. */
export async function runNativeOperation(
  schema: GraphQLSchema,
  fixture: NativeFixture,
  op: Operation,
  driver: Driver,
): Promise<string> {
  await resetAndSeed(driver, fixture.seed);
  const document = parse(op.document);
  const errors = validate(schema, document);
  const result: ExecutionResult = errors.length
    ? { errors }
    : await execute({ schema, document, variableValues: op.variables, contextValue: {} });
  const normalized = normalizeResult(result, { ordered: op.ordered });
  // Root fields resolve concurrently: errors come in completion order. Sort them by path.
  const key = (e: { path?: readonly (string | number)[]; message: string }) =>
    JSON.stringify([e.path ?? [], e.message]);
  normalized.errors?.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
  return stringifyResult(normalized);
}
