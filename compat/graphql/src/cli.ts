/**
 * `tsx src/cli.ts golden` regenerates goldens from @neo4j/graphql, then writes REPORT.md.
 * `tsx src/cli.ts report` compares every registered implementation and writes REPORT.md.
 * Extra arguments restrict the run to those fixtures (REPORT.md is then not written).
 * Both need NEO4J_TEST_URI / NEO4J_TEST_USER / NEO4J_TEST_PASSWORD (the database is wiped).
 */
import { writeFileSync } from "node:fs";
import { compareImplementation, writeGoldens } from "./compare.js";
import { loadFixtures, REPORT_PATH } from "./fixtures.js";
import { implementations, reference, referenceVersion } from "./implementations.js";
import { renderReport } from "./report.js";
import { connect, neo4jEnv } from "./runner.js";

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command !== "golden" && command !== "report") {
    console.error("usage: tsx src/cli.ts <golden|report>");
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
  try {
    const only = process.argv.slice(3);
    const fixtures = loadFixtures(only);
    if (command === "golden") {
      await writeGoldens(reference, fixtures, driver);
      console.log(`goldens written for ${fixtures.length} fixtures`);
    }
    const reports = [];
    for (const impl of implementations)
      reports.push(await compareImplementation(impl, fixtures, driver));
    if (only.length === 0)
      writeFileSync(REPORT_PATH, renderReport(reports, { referenceVersion: referenceVersion() }));
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
