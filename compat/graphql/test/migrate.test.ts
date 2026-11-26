/**
 * The migration tooling on the suite's fixtures (#249): the codemod translates or reports every v7
 * operation (no database), and each translated operation returns, on the native API, the v7
 * result mapped to the native shape (a disposable Neo4j, NEO4J_TEST_*).
 */
import { migrate } from "@cyphra/graphql";
import { validate, parse } from "graphql";
import type { Driver } from "neo4j-driver";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { COMPAT_ROOT, loadFixtures } from "../src/fixtures.js";
import {
  dualRunFixture,
  fixtureContext,
  translateFixture,
  type MigrateOutcome,
} from "../src/migrate.js";
import { connect, neo4jEnv } from "../src/runner.js";

const env = neo4jEnv();
const fixtures = loadFixtures();
/** Operations whose native result differs on purpose, with the reason. */
const expected = (
  JSON.parse(readFileSync(path.join(COMPAT_ROOT, "migrate-expected.json"), "utf8")) as {
    differences: Record<string, string>;
  }
).differences;

describe("codemod on the fixtures' operations", () => {
  for (const fixture of fixtures) {
    it(`${fixture.name}: translated operations validate against the native schema, others are left as they are`, () => {
      const ctx = fixtureContext(fixture);
      if (!ctx) return;
      for (const { op, translation } of translateFixture(fixture, ctx)) {
        if (translation.status === "translated") {
          expect(validate(ctx.nativeSchema, parse(translation.output)), op.name).toEqual([]);
          // Idempotent: the translation is a native document.
          expect(migrate.translateDocument(ctx, translation.output).status, op.name).toBe("native");
        } else {
          expect(translation.output, op.name).toBe(op.document);
          if (translation.status === "blocked") {
            expect(
              translation.issues.some((i) => i.kind === "blocking"),
              op.name,
            ).toBe(true);
          }
        }
      }
    });
  }
});

describe.skipIf(!env)("dual run: compat.v7 and the native API on the translated operations", () => {
  let driver: Driver;
  const outcomes: MigrateOutcome[] = [];
  beforeAll(() => {
    driver = connect(env!);
  });
  afterAll(async () => {
    await driver?.close();
  });

  for (const fixture of fixtures) {
    it(fixture.name, { timeout: 120_000 }, async () => {
      const results = await dualRunFixture(fixture, driver);
      outcomes.push(...results);
      const id = (r: MigrateOutcome) => `${r.fixture}/${r.operation}`;
      const unexpected = results.filter((r) => r.status === "differs" && !(id(r) in expected));
      expect(
        unexpected.map((d) => `${id(d)}: ${JSON.stringify(d.differences).slice(0, 2000)}`),
      ).toEqual([]);
      // An operation listed as differing that now gives the same result: update the list.
      const fixed = results.filter((r) => id(r) in expected && r.status !== "differs").map(id);
      expect(fixed).toEqual([]);
    });
  }
});
