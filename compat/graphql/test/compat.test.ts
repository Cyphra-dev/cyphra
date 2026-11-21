/**
 * Checks every registered implementation against the goldens generated from @neo4j/graphql:
 * printed SDL per fixture and normalized JSON per operation. Needs a disposable Neo4j
 * (NEO4J_TEST_URI / NEO4J_TEST_USER / NEO4J_TEST_PASSWORD, wiped between operations);
 * skipped when unset. Regenerate goldens with `pnpm --filter compat-graphql golden`.
 */
import { existsSync, readFileSync } from "node:fs";
import type { GraphQLSchema } from "graphql";
import type { Driver } from "neo4j-driver";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { goldenResultPath, goldenSchemaPath, loadFixtures } from "../src/fixtures.js";
import { implementations } from "../src/implementations.js";
import {
  buildFixtureSchema,
  connect,
  neo4jEnv,
  printSortedSchema,
  runOperation,
} from "../src/runner.js";

const env = neo4jEnv();
const fixtures = loadFixtures();

function golden(file: string): string {
  if (!existsSync(file))
    throw new Error(`missing golden ${file}; run pnpm --filter compat-graphql golden`);
  return readFileSync(file, "utf8");
}

describe.skipIf(!env)("GraphQL compatibility (goldens from @neo4j/graphql)", () => {
  let driver: Driver;
  beforeAll(() => {
    driver = connect(env!);
  });
  afterAll(async () => {
    await driver?.close();
  });

  it("has at least 5 fixtures", () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(5);
  });

  for (const impl of implementations) {
    describe(impl.name, async () => {
      const skipReason = await impl.skipReason?.();
      if (skipReason) {
        it.skip(`skipped: ${skipReason}`, () => {});
        return;
      }
      for (const fixture of fixtures) {
        describe(fixture.name, () => {
          let schema: GraphQLSchema;
          beforeAll(async () => {
            schema = await buildFixtureSchema(impl, fixture, driver);
          });

          it("schema (SDL)", () => {
            expect(printSortedSchema(schema)).toBe(golden(goldenSchemaPath(fixture.name)));
          });

          for (const op of fixture.operations) {
            it(op.name, async () => {
              const actual = await runOperation(impl, schema, fixture, op, driver);
              expect(actual).toBe(golden(goldenResultPath(fixture.name, op.name)));
            });
          }
        });
      }
    });
  }
});
