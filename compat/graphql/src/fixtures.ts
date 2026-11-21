import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// @neo4j/graphql parses Date/DateTime inputs in the process time zone: pin it so goldens
// do not depend on the machine (the npm scripts also set TZ=UTC).
process.env.TZ = "UTC";

export const COMPAT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const FIXTURES_DIR = path.join(COMPAT_ROOT, "fixtures");
export const GOLDEN_DIR = path.join(COMPAT_ROOT, "golden");
export const REPORT_PATH = path.join(COMPAT_ROOT, "REPORT.md");

/** One GraphQL operation of a fixture (`operations/<name>.graphql`). */
export type Operation = {
  fixture: string;
  /** File name without extension, e.g. `01-filter-scalars`. */
  name: string;
  document: string;
  variables: Record<string, unknown>;
  /** Decoded JWT payload passed in the context (`operations/<name>.jwt.json`), if any. */
  jwt?: Record<string, unknown>;
  /**
   * A token to sign and pass as `context.token` (`operations/<name>.token.json`): `payload` (the
   * claims, `exp` included) and optionally `key`, to sign with another key than the suite's (a
   * forged token).
   */
  token?: { payload: Record<string, unknown>; key?: string };
  /** Extra context values for `$context.<path>` rules (`operations/<name>.context.json`). */
  context?: Record<string, unknown>;
  /** Feature tags from the `# features:` header line; used to group the report. */
  features: string[];
  /**
   * `# ordered` header: array order is part of the expected result (sort, pagination).
   * Otherwise every array is sorted canonically before comparison.
   */
  ordered: boolean;
};

export type Fixture = {
  name: string;
  dir: string;
  typeDefs: string;
  seed: string;
  operations: Operation[];
};

function readJson(file: string): Record<string, unknown> | undefined {
  if (!existsSync(file)) return undefined;
  return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
}

function parseHeader(document: string): { features: string[]; ordered: boolean } {
  const features: string[] = [];
  let ordered = false;
  for (const line of document.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("#")) break;
    const body = trimmed.replace(/^#\s*/, "");
    if (body.startsWith("features:")) {
      features.push(
        ...body
          .slice("features:".length)
          .split(",")
          .map((f) => f.trim())
          .filter(Boolean),
      );
    } else if (body === "ordered") {
      ordered = true;
    }
  }
  return { features, ordered };
}

export function loadFixture(name: string): Fixture {
  const dir = path.join(FIXTURES_DIR, name);
  const opsDir = path.join(dir, "operations");
  const operations = readdirSync(opsDir)
    .filter((f) => f.endsWith(".graphql"))
    .sort()
    .map((file): Operation => {
      const opName = file.replace(/\.graphql$/, "");
      const document = readFileSync(path.join(opsDir, file), "utf8");
      const header = parseHeader(document);
      return {
        fixture: name,
        name: opName,
        document,
        variables: readJson(path.join(opsDir, `${opName}.variables.json`)) ?? {},
        jwt: readJson(path.join(opsDir, `${opName}.jwt.json`)),
        token: readJson(path.join(opsDir, `${opName}.token.json`)) as Operation["token"],
        context: readJson(path.join(opsDir, `${opName}.context.json`)),
        ...header,
      };
    });
  return {
    name,
    dir,
    typeDefs: readFileSync(path.join(dir, "typeDefs.graphql"), "utf8"),
    seed: readFileSync(path.join(dir, "seed.cypher"), "utf8"),
    operations,
  };
}

/** Loads every fixture, or only the named ones. */
export function loadFixtures(only: string[] = []): Fixture[] {
  return readdirSync(FIXTURES_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((name) => only.length === 0 || only.includes(name))
    .sort()
    .map(loadFixture);
}

export function goldenSchemaPath(fixture: string): string {
  return path.join(GOLDEN_DIR, fixture, "schema.graphql");
}

export function goldenResultPath(fixture: string, operation: string): string {
  return path.join(GOLDEN_DIR, fixture, `${operation}.json`);
}
