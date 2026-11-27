import {
  execute,
  lexicographicSortSchema,
  parse,
  printSchema,
  subscribe,
  validate,
  type ExecutionResult,
  type GraphQLSchema,
} from "graphql";
import neo4j, { type Driver } from "neo4j-driver";
import { loadResolvers, type Fixture, type Operation } from "./fixtures.js";
import { JWT_KEY, type GraphQLImplementation } from "./implementations.js";
import { normalizeResult, stringifyResult, type NormalizedResult } from "./normalize.js";

export type Neo4jEnv = { uri: string; user: string; password: string };

export function neo4jEnv(): Neo4jEnv | undefined {
  const { NEO4J_TEST_URI: uri, NEO4J_TEST_USER: user, NEO4J_TEST_PASSWORD: password } = process.env;
  return uri && user && password ? { uri, user, password } : undefined;
}

export function connect(env: Neo4jEnv): Driver {
  return neo4j.driver(env.uri, neo4j.auth.basic(env.user, env.password));
}

/** Splits a seed file into statements (`;` at end of line), dropping `//` comment lines. */
export function seedStatements(seed: string): string[] {
  const withoutComments = seed
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
  return withoutComments
    .split(/;\s*(?:\n|$)/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Empties the database (nodes, relationships, constraints, indexes) and applies the seed. */
export async function resetAndSeed(driver: Driver, seed: string): Promise<void> {
  const session = driver.session();
  try {
    await session.run("MATCH (n) DETACH DELETE n");
    const constraints = await session.run("SHOW CONSTRAINTS YIELD name RETURN name");
    for (const r of constraints.records)
      await session.run(`DROP CONSTRAINT \`${r.get("name")}\` IF EXISTS`);
    const indexes = await session.run(
      "SHOW INDEXES YIELD name, type WHERE type <> 'LOOKUP' RETURN name",
    );
    for (const r of indexes.records) await session.run(`DROP INDEX \`${r.get("name")}\` IF EXISTS`);
    for (const statement of seedStatements(seed)) {
      await session.executeWrite((tx) => tx.run(statement));
    }
  } finally {
    await session.close();
  }
}

export function printSortedSchema(schema: GraphQLSchema): string {
  return `${printSchema(lexicographicSortSchema(schema))}\n`;
}

/** `printSchema` as is: types, fields, arguments and values in the implementation's order. */
export function printUnsortedSchema(schema: GraphQLSchema): string {
  return `${printSchema(schema)}\n`;
}

export async function buildFixtureSchema(
  impl: GraphQLImplementation,
  fixture: Fixture,
  driver: Driver,
): Promise<GraphQLSchema> {
  return impl.buildSchema(fixture.typeDefs, {
    driver,
    jwt: { key: JWT_KEY },
    resolvers: await loadResolvers(fixture),
  });
}

/** Resets the database, applies the fixture seed, runs one operation and returns normalized JSON. */
export async function runOperation(
  impl: GraphQLImplementation,
  schema: GraphQLSchema,
  fixture: Fixture,
  op: Operation,
  driver: Driver,
): Promise<string> {
  await resetAndSeed(driver, fixture.seed);
  const document = parse(op.document);
  // Validated first, like a GraphQL server: an operation using a field or argument the schema
  // does not have (e.g. a mutation hidden by `@mutation`) gets the validation errors.
  const errors = validate(schema, document);
  const result: ExecutionResult = errors.length
    ? { errors }
    : await execute({
        schema,
        document,
        variableValues: op.variables,
        contextValue: await impl.contextFor(op),
      });
  return stringifyResult(normalizeResult(result, { ordered: op.ordered }));
}

/**
 * Whether the database serves Change Data Capture (Neo4j Enterprise / Aura with
 * `txLogEnrichment` set): `subscription` operations are skipped otherwise.
 */
export async function cdcAvailable(driver: Driver): Promise<boolean> {
  try {
    await driver.executeQuery("CALL db.cdc.current()");
    return true;
  } catch {
    return false;
  }
}

export const CDC_SKIP_REASON =
  "needs Neo4j CDC (Enterprise, txLogEnrichment FULL): see compat/graphql/README.md";

/** CDC polling interval of the engines under test, and how long to wait for the last events. */
export const POLL_MS = 50;
const MIN_WAIT_MS = 1000;
const QUIET_MS = 500;

const canonical = (v: unknown) => JSON.stringify(v);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The context of a subscription: v7 reads the token from `connectionParams.token` (what a
 * graphql-ws client sends when connecting), not from `context.token`.
 */
function subscriptionContext(context: Record<string, unknown>): Record<string, unknown> {
  const { token, ...rest } = context;
  return token === undefined ? rest : { ...rest, connectionParams: { token } };
}

/**
 * Resets the database and applies the seed, builds a schema with a CDC engine, subscribes, runs
 * `<name>.script.cypher` (one transaction per statement) and returns the events received,
 * normalized: in order with `# ordered`, sorted otherwise. A subscription that fails to start returns its errors instead.
 */
export async function runSubscription(
  impl: GraphQLImplementation,
  fixture: Fixture,
  op: Operation,
  driver: Driver,
): Promise<string> {
  await resetAndSeed(driver, fixture.seed);
  const { schema, close } = await impl.buildSubscriptionSchema(fixture.typeDefs, {
    driver,
    jwt: { key: JWT_KEY },
    resolvers: await loadResolvers(fixture),
    pollTime: POLL_MS,
  });
  try {
    return await collectEvents(
      await subscribe({
        schema,
        document: parse(op.document),
        variableValues: op.variables,
        contextValue: subscriptionContext(await impl.contextFor(op)),
      }),
      op,
      driver,
    );
  } finally {
    await close();
  }
}

/**
 * The events of a subscription started with `result`: runs `<name>.script.cypher` (one
 * transaction per statement), waits for the last events, and returns them normalized (in order
 * with `# ordered`, sorted otherwise), or the errors of a subscription that failed to start.
 */
export async function collectEvents(
  result:
    AsyncGenerator<ExecutionResult> | AsyncIterableIterator<ExecutionResult> | ExecutionResult,
  op: Operation,
  driver: Driver,
): Promise<string> {
  if (!(Symbol.asyncIterator in result)) {
    return stringifyResult(normalizeResult(result, { ordered: op.ordered }));
  }
  const events: NormalizedResult[] = [];
  let lastEventAt = 0;
  const iterator = result[Symbol.asyncIterator]();
  const pump = (async () => {
    for (;;) {
      const next = await iterator.next();
      if (next.done) return;
      events.push(
        normalizeResult(next.value as ExecutionResult, {
          ordered: op.ordered,
          maskTimestamps: true,
        }),
      );
      lastEventAt = Date.now();
    }
  })();
  const session = driver.session();
  try {
    for (const statement of seedStatements(op.script ?? "")) {
      await session.executeWrite((tx) => tx.run(statement));
    }
  } finally {
    await session.close();
  }
  const scriptDone = Date.now();
  while (Date.now() - scriptDone < MIN_WAIT_MS || Date.now() - lastEventAt < QUIET_MS) {
    await sleep(POLL_MS);
  }
  await iterator.return?.();
  await pump;
  // Events of one transaction come in no guaranteed order: sorted unless `# ordered`.
  if (!op.ordered) events.sort((a, b) => canonical(a).localeCompare(canonical(b)));
  return stringifyResult({ events } as NormalizedResult);
}
