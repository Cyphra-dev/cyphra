/**
 * The native suite: fixtures written for `native.makeSchema` (`native/fixtures/<app>/`:
 * `schema.cyphra`, optional `config.ts` (its default export is the config; an optional `client`
 * export extends the fixture's client), `seed.cypher`, `operations/`) and their goldens
 * (`native/golden/<app>/`: the sorted SDL and the normalized result of each operation). There is
 * no reference implementation: goldens are written by the native API itself (`golden:native`)
 * and reviewed, so any change of the printed contract or of a result shows up as a golden diff.
 * `subscription` operations are subscribed to, then `<name>.script.cypher` runs and the events
 * received are the result (needs Neo4j CDC, like the subscription fixtures of compat.v7).
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { native, type GraphQLConfig } from "@cyphra/graphql";
import { createOrm } from "@cyphra/runtime";
import { parseSchema, resolveSchema, type SchemaModel } from "@cyphra/schema";
import {
  execute,
  parse,
  subscribe,
  validate,
  type ExecutionResult,
  type GraphQLSchema,
} from "graphql";
import type { Driver } from "neo4j-driver";
import { COMPAT_ROOT, loadOperations, type Operation } from "./fixtures.js";
import { normalizeResult, stringifyResult } from "./normalize.js";
import { JWT_KEY, operationContext } from "./implementations.js";
import { collectEvents, POLL_MS, resetAndSeed } from "./runner.js";

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

type ConfigModule = {
  default: GraphQLConfig;
  /** Optional: the fixture's client from the plain one (`db.$extends(…)`, for computed fields). */
  client?: (db: object) => object;
};

async function configModule(fixture: NativeFixture): Promise<ConfigModule | undefined> {
  if (!fixture.configPath) return undefined;
  return (await import(pathToFileURL(fixture.configPath).href)) as ConfigModule;
}

export async function nativeConfig(fixture: NativeFixture): Promise<GraphQLConfig | undefined> {
  return (await configModule(fixture))?.default;
}

/** The fixture's sorted SDL (`native.printSchema`), as committed in `schema.graphql`. */
export async function printNativeSchema(fixture: NativeFixture): Promise<string> {
  return native.printSchema(fixture.schema, await nativeConfig(fixture));
}

/**
 * The fixture's schema, with a CDC reader for its subscriptions (`reader`, or one of its own that
 * polls only while a subscription is open).
 */
export async function buildNativeSchema(
  fixture: NativeFixture,
  driver: Driver,
  reader: InstanceType<typeof native.CDCReader> = new native.CDCReader({ driver }),
): Promise<GraphQLSchema> {
  const mod = await configModule(fixture);
  const db = createOrm(fixture.schema, { driver });
  return native.makeSchema({
    client: mod?.client ? mod.client(db) : db,
    config: mod?.default,
    subscriptions: reader,
  });
}

export function nativeGoldenSchemaPath(fixture: string): string {
  return path.join(NATIVE_GOLDEN_DIR, fixture, "schema.graphql");
}

export function nativeGoldenResultPath(fixture: string, operation: string): string {
  return path.join(NATIVE_GOLDEN_DIR, fixture, `${operation}.json`);
}

/**
 * The context of an operation for the native API: `<name>.context.json` values, `jwt` (a decoded
 * payload, trusted as-is) and, for `<name>.token.json`, what `native.jwtContext` makes of the
 * signed `Authorization` header (with the suite key: a token signed with another key is
 * anonymous).
 */
async function nativeContext(op: Operation): Promise<Record<string, unknown>> {
  const { token, ...context } = await operationContext(op);
  if (typeof token !== "string") return context;
  const verified = await native.jwtContext({ key: JWT_KEY })({
    req: { headers: { authorization: token } },
  });
  return { ...context, ...verified };
}

/**
 * Resets the database and applies the seed, subscribes with a CDC reader of its own, runs
 * `<name>.script.cypher` and returns the events received, normalized (see `collectEvents`).
 */
export async function runNativeSubscription(
  fixture: NativeFixture,
  op: Operation,
  driver: Driver,
): Promise<string> {
  await resetAndSeed(driver, fixture.seed);
  const reader = new native.CDCReader({ driver, pollInterval: POLL_MS });
  try {
    const schema = await buildNativeSchema(fixture, driver, reader);
    const document = parse(op.document);
    const errors = validate(schema, document);
    return await collectEvents(
      errors.length
        ? { errors }
        : await subscribe({
            schema,
            document,
            variableValues: op.variables,
            contextValue: await nativeContext(op),
          }),
      op,
      driver,
    );
  } finally {
    reader.close();
  }
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
    : await execute({
        schema,
        document,
        variableValues: op.variables,
        contextValue: await nativeContext(op),
      });
  const normalized = normalizeResult(result, { ordered: op.ordered });
  // Root fields resolve concurrently: errors come in completion order. Sort them by path.
  const key = (e: { path?: readonly (string | number)[]; message: string }) =>
    JSON.stringify([e.path ?? [], e.message]);
  normalized.errors?.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
  return stringifyResult(normalized);
}
