import { execute, lexicographicSortSchema, parse, printSchema, type GraphQLSchema } from "graphql";
import neo4j, { type Driver } from "neo4j-driver";
import type { Fixture, Operation } from "./fixtures.js";
import { JWT_KEY, type GraphQLImplementation } from "./implementations.js";
import { normalizeResult, stringifyResult } from "./normalize.js";

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

export async function buildFixtureSchema(
  impl: GraphQLImplementation,
  fixture: Fixture,
  driver: Driver,
): Promise<GraphQLSchema> {
  return impl.buildSchema(fixture.typeDefs, { driver, jwt: { key: JWT_KEY } });
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
  const result = await execute({
    schema,
    document: parse(op.document),
    variableValues: op.variables,
    contextValue: await impl.contextFor(op),
  });
  return stringifyResult(normalizeResult(result, { ordered: op.ordered }));
}
