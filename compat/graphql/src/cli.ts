/**
 * `tsx src/cli.ts golden` regenerates goldens from @neo4j/graphql, then writes REPORT.md.
 * `tsx src/cli.ts report` compares every registered implementation and writes REPORT.md.
 * Extra arguments restrict the run to those fixtures (REPORT.md is then not written).
 * `--update-expected` rewrites cyphra-expected.json from the checks that pass (full runs only).
 * `tsx src/cli.ts golden-native` writes the goldens of the native suite (native/fixtures) from
 * `native.makeSchema` itself: review the diff.
 * All need NEO4J_TEST_URI / NEO4J_TEST_USER / NEO4J_TEST_PASSWORD (the database is wiped).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { compareImplementation, writeGoldens } from "./compare.js";
import { expectationMismatches, unlistedPassHint, writeExpected } from "./expected.js";
import { loadFixtures, REPORT_PATH } from "./fixtures.js";
import { implementations, reference, referenceVersion } from "./implementations.js";
import { renderReport } from "./report.js";
import {
  buildNativeSchema,
  loadNativeFixtures,
  nativeGoldenResultPath,
  nativeGoldenSchemaPath,
  printNativeSchema,
  runNativeOperation,
  runNativeSubscription,
} from "./native.js";
import { CDC_SKIP_REASON, cdcAvailable, connect, neo4jEnv } from "./runner.js";

async function writeNativeGoldens(only: string[], driver: ReturnType<typeof connect>) {
  const write = (file: string, text: string) => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
  };
  const cdc = await cdcAvailable(driver);
  for (const fixture of loadNativeFixtures(only)) {
    write(nativeGoldenSchemaPath(fixture.name), await printNativeSchema(fixture));
    const schema = await buildNativeSchema(fixture, driver);
    for (const op of fixture.operations) {
      if (op.kind === "subscription") {
        // Without CDC, the committed golden is kept.
        if (!cdc) {
          console.warn(`  kept ${fixture.name}/${op.name}: ${CDC_SKIP_REASON}`);
          continue;
        }
        write(
          nativeGoldenResultPath(fixture.name, op.name),
          await runNativeSubscription(fixture, op, driver),
        );
        continue;
      }
      write(
        nativeGoldenResultPath(fixture.name, op.name),
        await runNativeOperation(schema, fixture, op, driver),
      );
    }
    console.log(`native goldens written for ${fixture.name}`);
  }
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command !== "golden" && command !== "report" && command !== "golden-native") {
    console.error("usage: tsx src/cli.ts <golden|golden-native|report>");
    process.exit(2);
  }
  const env = neo4jEnv();
  if (!env) {
    console.error(
      "NEO4J_TEST_URI, NEO4J_TEST_USER and NEO4J_TEST_PASSWORD must be set (the database is wiped).",
    );
    process.exit(2);
  }
  const driver = connect(env);
  if (command === "golden-native") {
    try {
      await writeNativeGoldens(process.argv.slice(3), driver);
    } finally {
      await driver.close();
    }
    return;
  }
  try {
    const args = process.argv.slice(3);
    const updateExpected = args.includes("--update-expected");
    const only = args.filter((a) => !a.startsWith("--"));
    const fixtures = loadFixtures(only);
    if (command === "golden") {
      await writeGoldens(reference, fixtures, driver);
      console.log(`goldens written for ${fixtures.length} fixtures`);
    }
    const reports = [];
    for (const impl of implementations)
      reports.push(await compareImplementation(impl, fixtures, driver));
    if (only.length === 0) {
      writeFileSync(REPORT_PATH, renderReport(reports, { referenceVersion: referenceVersion() }));
      if (updateExpected) writeExpected(reports);
    }
    for (const r of reports) {
      const checks = r.fixtures.flatMap((f) => f.checks);
      const count = (s: string) => checks.filter((c) => c.status === s).length;
      console.log(
        `${r.implementation}: ${count("pass")} pass, ${count("fail")} fail, ${count("skipped")} skipped`,
      );
      for (const f of r.fixtures)
        for (const c of f.checks)
          if (c.status === "fail") console.log(`  FAIL ${f.fixture}/${c.check}: ${c.detail}`);
    }
    if (only.length === 0 && !updateExpected) {
      for (const m of expectationMismatches(reports)) {
        process.exitCode = 1;
        console.log(
          m.kind === "regression"
            ? `  REGRESSION ${m.implementation} ${m.id}: listed in cyphra-expected.json but fails`
            : `  NEW PASS ${unlistedPassHint(m.implementation, m.id)}`,
        );
      }
    }
    if (
      reports
        .find((r) => r.implementation === reference.name)
        ?.fixtures.some((f) => f.checks.some((c) => c.status === "fail"))
    )
      process.exitCode = 1;
  } finally {
    await driver.close();
  }
}

await main();
