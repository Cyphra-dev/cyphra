import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Driver } from "neo4j-driver";
import { goldenResultPath, goldenSchemaPath, type Fixture } from "./fixtures.js";
import type { GraphQLImplementation } from "./implementations.js";
import {
  buildFixtureSchema,
  CDC_SKIP_REASON,
  cdcAvailable,
  printSortedSchema,
  runOperation,
  runSubscription,
} from "./runner.js";

export type Status = "pass" | "fail" | "skipped";

export type CheckResult = {
  /** `schema` for the SDL check, otherwise the operation name. */
  check: string;
  features: string[];
  status: Status;
  /** Why it failed or was skipped. */
  detail?: string;
  /** Actual output on failure, for diffing against the golden file. */
  actual?: string;
  expected?: string;
};

export type FixtureReport = { fixture: string; checks: CheckResult[] };

export type ImplementationReport = {
  implementation: string;
  skipReason?: string;
  fixtures: FixtureReport[];
};

function readGolden(file: string): string | undefined {
  return existsSync(file) ? readFileSync(file, "utf8") : undefined;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** ` (error: …)` when the actual result has errors and the golden does not explain the diff. */
function firstError(actual: string): string {
  try {
    const parsed = JSON.parse(actual) as { errors?: { message?: string }[] };
    const message = parsed.errors?.[0]?.message;
    return message ? ` (error: ${message})` : "";
  } catch {
    return "";
  }
}

function compareText(
  check: string,
  features: string[],
  actual: string,
  expected: string | undefined,
): CheckResult {
  if (expected === undefined)
    return { check, features, status: "fail", detail: "golden file missing", actual };
  if (actual === expected) return { check, features, status: "pass" };
  return {
    check,
    features,
    status: "fail",
    detail: `output differs from golden${firstError(actual)}`,
    actual,
    expected,
  };
}

/** Runs one implementation over every fixture and compares SDL and results with the goldens. */
export async function compareImplementation(
  impl: GraphQLImplementation,
  fixtures: Fixture[],
  driver: Driver,
): Promise<ImplementationReport> {
  const skipReason = await impl.skipReason?.();
  if (skipReason) {
    return {
      implementation: impl.name,
      skipReason,
      fixtures: fixtures.map((f) => ({
        fixture: f.name,
        checks: [
          { check: "schema", features: ["schema"], status: "skipped", detail: skipReason },
          ...f.operations.map((op): CheckResult => ({
            check: op.name,
            features: op.features,
            status: "skipped",
            detail: skipReason,
          })),
        ],
      })),
    };
  }

  const cdc = await cdcAvailable(driver);
  const reports: FixtureReport[] = [];
  for (const fixture of fixtures) {
    const checks: CheckResult[] = [];
    let schema;
    try {
      schema = await buildFixtureSchema(impl, fixture, driver);
      checks.push(
        compareText(
          "schema",
          ["schema"],
          printSortedSchema(schema),
          readGolden(goldenSchemaPath(fixture.name)),
        ),
      );
    } catch (err) {
      checks.push({
        check: "schema",
        features: ["schema"],
        status: "fail",
        detail: `buildSchema threw: ${errorMessage(err)}`,
      });
    }
    for (const op of fixture.operations) {
      if (op.kind === "subscription" && !cdc) {
        checks.push({
          check: op.name,
          features: op.features,
          status: "skipped",
          detail: CDC_SKIP_REASON,
        });
        continue;
      }
      if (!schema) {
        checks.push({ check: op.name, features: op.features, status: "fail", detail: "no schema" });
        continue;
      }
      try {
        const actual =
          op.kind === "subscription"
            ? await runSubscription(impl, fixture, op, driver)
            : await runOperation(impl, schema, fixture, op, driver);
        checks.push(
          compareText(
            op.name,
            op.features,
            actual,
            readGolden(goldenResultPath(fixture.name, op.name)),
          ),
        );
      } catch (err) {
        checks.push({
          check: op.name,
          features: op.features,
          status: "fail",
          detail: `execute threw: ${errorMessage(err)}`,
        });
      }
    }
    reports.push({ fixture: fixture.name, checks });
  }
  return { implementation: impl.name, fixtures: reports };
}

/** Regenerates the golden SDL and results from the reference implementation. */
export async function writeGoldens(
  impl: GraphQLImplementation,
  fixtures: Fixture[],
  driver: Driver,
): Promise<void> {
  const cdc = await cdcAvailable(driver);
  for (const fixture of fixtures) {
    const schema = await buildFixtureSchema(impl, fixture, driver);
    const schemaFile = goldenSchemaPath(fixture.name);
    mkdirSync(path.dirname(schemaFile), { recursive: true });
    writeFileSync(schemaFile, printSortedSchema(schema));
    for (const op of fixture.operations) {
      if (op.kind === "subscription") {
        if (!cdc) {
          console.warn(`  kept golden of ${fixture.name}/${op.name}: ${CDC_SKIP_REASON}`);
          continue;
        }
        writeFileSync(
          goldenResultPath(fixture.name, op.name),
          await runSubscription(impl, fixture, op, driver),
        );
        continue;
      }
      writeFileSync(
        goldenResultPath(fixture.name, op.name),
        await runOperation(impl, schema, fixture, op, driver),
      );
    }
  }
}
