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
import { checkId, mustPass, unlistedPassHint } from "../src/expected.js";
import { implementations } from "../src/implementations.js";
import {
  buildFixtureSchema,
  CDC_SKIP_REASON,
  cdcAvailable,
  connect,
  neo4jEnv,
  printSortedSchema,
  runOperation,
  runSubscription,
} from "../src/runner.js";

const env = neo4jEnv();
const fixtures = loadFixtures();
// `subscription` operations need Change Data Capture (Neo4j Enterprise): skipped without it.
const cdc = env
  ? await (async () => {
      const driver = connect(env);
      try {
        return await cdcAvailable(driver);
      } finally {
        await driver.close();
      }
    })()
  : false;

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

  it.skipIf(!!process.env.COMPAT_FIXTURES)("has at least 5 fixtures", () => {
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
          let schema: GraphQLSchema | undefined;
          let buildError: unknown;
          beforeAll(async () => {
            try {
              schema = await buildFixtureSchema(impl, fixture, driver);
            } catch (err) {
              buildError = err;
            }
          });

          /**
           * The reference must match every golden. Other implementations run in progress mode:
           * checks listed in cyphra-expected.json must match; any other check must not (a new
           * pass has to be added to the list).
           */
          async function check(name: string, actual: () => Promise<string>, expected: string) {
            const id = checkId(fixture.name, name);
            if (mustPass(impl, fixture.name, name)) {
              if (!schema) throw buildError;
              expect(await actual()).toBe(expected);
              return;
            }
            let passes = false;
            try {
              passes = !!schema && (await actual()) === expected;
            } catch {
              passes = false;
            }
            if (passes) throw new Error(unlistedPassHint(impl.name, id));
          }

          it("schema (SDL)", async () => {
            await check(
              "schema",
              async () => printSortedSchema(schema!),
              golden(goldenSchemaPath(fixture.name)),
            );
          });

          for (const op of fixture.operations) {
            if (op.kind === "subscription") {
              it.skipIf(!cdc)(`${op.name}${cdc ? "" : ` (${CDC_SKIP_REASON})`}`, async () => {
                await check(
                  op.name,
                  () => runSubscription(impl, fixture, op, driver),
                  golden(goldenResultPath(fixture.name, op.name)),
                );
              });
              continue;
            }
            it(op.name, async () => {
              await check(
                op.name,
                () => runOperation(impl, schema!, fixture, op, driver),
                golden(goldenResultPath(fixture.name, op.name)),
              );
            });
          }
        });
      }
    });
  }
});
