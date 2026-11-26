/**
 * The native suite (native/fixtures): the printed SDL of each fixture and the normalized result of
 * each operation must match the goldens in native/golden, written by `golden:native` and reviewed.
 * The SDL check needs no database; operations need a disposable Neo4j (NEO4J_TEST_*).
 */
import { existsSync, readFileSync } from "node:fs";
import type { GraphQLSchema } from "graphql";
import type { Driver } from "neo4j-driver";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildNativeSchema,
  loadNativeFixtures,
  nativeGoldenResultPath,
  nativeGoldenSchemaPath,
  printNativeSchema,
  runNativeOperation,
} from "../src/native.js";
import { connect, neo4jEnv } from "../src/runner.js";

const env = neo4jEnv();
const fixtures = loadNativeFixtures();

function golden(file: string): string {
  if (!existsSync(file))
    throw new Error(`missing golden ${file}; run pnpm --filter compat-graphql golden:native`);
  return readFileSync(file, "utf8");
}

describe("native API (goldens in native/golden)", () => {
  let driver: Driver | undefined;
  beforeAll(() => {
    if (env) driver = connect(env);
  });
  afterAll(async () => {
    await driver?.close();
  });

  it("has fixtures", () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(3);
  });

  for (const fixture of fixtures) {
    describe(fixture.name, () => {
      it("schema (printed SDL)", async () => {
        expect(await printNativeSchema(fixture)).toBe(golden(nativeGoldenSchemaPath(fixture.name)));
      });

      describe.skipIf(!env)("operations", () => {
        let schema: GraphQLSchema;
        beforeAll(async () => {
          schema = await buildNativeSchema(fixture, driver!);
        });
        for (const op of fixture.operations) {
          it(op.name, async () => {
            expect(await runNativeOperation(schema, fixture, op, driver!)).toBe(
              golden(nativeGoldenResultPath(fixture.name, op.name)),
            );
          });
        }
      });
    });
  }
});
