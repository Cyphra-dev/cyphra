/**
 * `tsx src/differential.ts [fixture…]`: runs every non-subscription operation of the v7 suite on
 * `@cyphra/graphql` twice, with the shared engine forced off (every request on the compat
 * compiler) and on, and prints the operations whose normalized results differ (the run fails when
 * one does). It also counts the root fields the engine served, and why the others fell back.
 *
 * `compat.v7` serves a request on the engine only when it answers exactly like the compiler, so
 * this run must report 0 differences. It goes further than the goldens: it also compares the
 * operations whose golden `@cyphra/graphql` deliberately does not match.
 *
 * Needs NEO4J_TEST_URI / NEO4J_TEST_USER / NEO4J_TEST_PASSWORD (the database is wiped).
 */
import { compat } from "@cyphra/graphql";
import { loadFixtures, loadResolvers } from "./fixtures.js";
import { JWT_KEY, cyphraGraphQL } from "./implementations.js";
import { connect, neo4jEnv, runOperation } from "./runner.js";

/** The internal option of `compat.v7.makeSchema` that turns the engine off or probes it. */
const ENGINE_OPTION = Symbol.for("cyphra.compat.v7.engine");

type Probe = { onRootField(field: string, reason: string | undefined): void };

async function main(): Promise<void> {
  const env = neo4jEnv();
  if (!env) {
    console.error("NEO4J_TEST_URI, NEO4J_TEST_USER and NEO4J_TEST_PASSWORD must be set.");
    process.exit(2);
  }
  const verbose = process.argv.includes("--verbose");
  const only = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const driver = connect(env);
  let operations = 0;
  let onEngine = 0;
  let mutationsOnEngine = 0;
  const reasons = new Map<string, number>();
  const differences: string[] = [];
  try {
    for (const fixture of loadFixtures(only)) {
      const resolvers = await loadResolvers(fixture);
      const build = (engine: false | Probe) =>
        compat.v7.makeSchema({
          typeDefs: fixture.typeDefs,
          driver,
          resolvers,
          features: { authorization: { key: JWT_KEY } },
          [ENGINE_OPTION]: engine,
        } as Parameters<typeof compat.v7.makeSchema>[0]);
      let current = "";
      const probe: Probe = {
        onRootField(field, reason) {
          if (reason === undefined) {
            onEngine++;
            if (/^(create|update|delete)[A-Z]/.test(field)) mutationsOnEngine++;
            if (verbose) console.log(`  engine   ${current} ${field}`);
          } else {
            reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
            if (verbose) console.log(`  compiler ${current} ${field}: ${reason}`);
          }
        },
      };
      const off = build(false);
      const on = build(probe);
      for (const op of fixture.operations) {
        if (op.kind === "subscription") continue;
        operations++;
        current = `${fixture.name}/${op.name}`;
        const a = await runOperation(cyphraGraphQL, off, fixture, op, driver);
        const b = await runOperation(cyphraGraphQL, on, fixture, op, driver);
        if (a !== b) {
          differences.push(current);
          console.log(`DIFF ${current}\n  off: ${a.slice(0, 600)}\n  on:  ${b.slice(0, 600)}`);
        }
      }
    }
  } finally {
    await driver.close();
  }
  console.log(
    `\n${operations} operations, ${differences.length} differences; ${onEngine} root fields on the engine (${mutationsOnEngine} mutations)`,
  );
  console.log("Fallbacks (root fields on the compat compiler, by reason):");
  for (const [reason, n] of [...reasons].sort((x, y) => y[1] - x[1])) {
    console.log(`  ${String(n).padStart(4)}  ${reason}`);
  }
  if (differences.length) process.exitCode = 1;
}

await main();
