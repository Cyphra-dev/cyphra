import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { COMPAT_ROOT } from "./fixtures.js";
import type { ImplementationReport } from "./compare.js";
import { reference, type GraphQLImplementation } from "./implementations.js";

/**
 * Progress mode for implementations other than the reference: `cyphra-expected.json` lists the
 * checks (`<fixture>/schema`, `<fixture>/schema-print` or `<fixture>/<operation>`) that must pass.
 * A listed check that fails is a regression; a check that passes without being listed must be
 * added, so the list stays honest.
 */
export const EXPECTED_PATH = path.join(COMPAT_ROOT, "cyphra-expected.json");

type ExpectedFile = { description: string; implementations: Record<string, string[]> };

function readExpected(): ExpectedFile {
  return JSON.parse(readFileSync(EXPECTED_PATH, "utf8")) as ExpectedFile;
}

export function checkId(fixture: string, check: string): string {
  return `${fixture}/${check}`;
}

/** Whether `impl` must pass the check. The reference must pass everything. */
export function mustPass(impl: GraphQLImplementation, fixture: string, check: string): boolean {
  if (impl.name === reference.name) return true;
  return (readExpected().implementations[impl.name] ?? []).includes(checkId(fixture, check));
}

export type ExpectationMismatch = {
  implementation: string;
  id: string;
  kind: "regression" | "unlisted-pass";
};

/** Listed checks that fail, and passing checks that are not listed. */
export function expectationMismatches(reports: ImplementationReport[]): ExpectationMismatch[] {
  const out: ExpectationMismatch[] = [];
  const expected = readExpected().implementations;
  for (const r of reports) {
    if (r.implementation === reference.name || r.skipReason) continue;
    const listed = new Set(expected[r.implementation] ?? []);
    for (const f of r.fixtures) {
      for (const c of f.checks) {
        const id = checkId(f.fixture, c.check);
        // Skipped checks (e.g. subscriptions without CDC) say nothing about the implementation.
        if (listed.has(id) && c.status === "fail")
          out.push({ implementation: r.implementation, id, kind: "regression" });
        if (!listed.has(id) && c.status === "pass")
          out.push({ implementation: r.implementation, id, kind: "unlisted-pass" });
      }
    }
  }
  return out;
}

/** Rewrites the list from a full report run (`report --update-expected`). */
export function writeExpected(reports: ImplementationReport[]): void {
  const file = readExpected();
  for (const r of reports) {
    if (r.implementation === reference.name || r.skipReason) continue;
    // A skipped check keeps its entry: it was not run (e.g. subscriptions without CDC).
    const listed = new Set(file.implementations[r.implementation] ?? []);
    file.implementations[r.implementation] = r.fixtures.flatMap((f) =>
      f.checks
        .filter(
          (c) =>
            c.status === "pass" ||
            (c.status === "skipped" && listed.has(checkId(f.fixture, c.check))),
        )
        .map((c) => checkId(f.fixture, c.check)),
    );
  }
  writeFileSync(EXPECTED_PATH, `${JSON.stringify(file, null, 2)}\n`);
}

export function unlistedPassHint(implementation: string, id: string): string {
  return `${id} now passes on ${implementation}: add "${id}" to compat/graphql/cyphra-expected.json (or run \`pnpm --filter compat-graphql report --update-expected\`).`;
}
