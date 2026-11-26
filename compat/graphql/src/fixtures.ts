import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { Kind, parse } from "graphql";
import { fileURLToPath, pathToFileURL } from "node:url";

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
  /**
   * `subscription` operations are subscribed to, then `<name>.script.cypher` runs and the events
   * received are the result (needs Neo4j CDC). Others are executed once.
   */
  kind: "execute" | "subscription";
  /** Cypher statements run after subscribing (`operations/<name>.script.cypher`). */
  script?: string;
};

/** Resolver map passed to every implementation as `resolvers` (`fixtures/<app>/resolvers.ts`). */
export type FixtureResolvers = Record<string, Record<string, unknown>>;

export type Fixture = {
  name: string;
  dir: string;
  typeDefs: string;
  seed: string;
  /** `resolvers.ts` (its default export), when the fixture has one. */
  resolversPath?: string;
  operations: Operation[];
};

/** The fixture's resolvers (default export of `resolvers.ts`), if any. */
export async function loadResolvers(fixture: Fixture): Promise<FixtureResolvers | undefined> {
  if (!fixture.resolversPath) return undefined;
  const mod = (await import(pathToFileURL(fixture.resolversPath).href)) as {
    default: FixtureResolvers;
  };
  return mod.default;
}

function readJson(file: string): Record<string, unknown> | undefined {
  if (!existsSync(file)) return undefined;
  return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
}

function operationKind(document: string): Operation["kind"] {
  const isSubscription = parse(document).definitions.some(
    (d) => d.kind === Kind.OPERATION_DEFINITION && d.operation === "subscription",
  );
  return isSubscription ? "subscription" : "execute";
}

function readText(file: string): string | undefined {
  return existsSync(file) ? readFileSync(file, "utf8") : undefined;
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

/** The operations of a fixture (`<opsDir>/*.graphql` and their side files). */
export function loadOperations(fixture: string, opsDir: string): Operation[] {
  return readdirSync(opsDir)
    .filter((f) => f.endsWith(".graphql"))
    .sort()
    .map((file): Operation => {
      const opName = file.replace(/\.graphql$/, "");
      const document = readFileSync(path.join(opsDir, file), "utf8");
      const header = parseHeader(document);
      return {
        fixture,
        name: opName,
        document,
        variables: readJson(path.join(opsDir, `${opName}.variables.json`)) ?? {},
        jwt: readJson(path.join(opsDir, `${opName}.jwt.json`)),
        token: readJson(path.join(opsDir, `${opName}.token.json`)) as Operation["token"],
        context: readJson(path.join(opsDir, `${opName}.context.json`)),
        ...header,
        kind: operationKind(document),
        script: readText(path.join(opsDir, `${opName}.script.cypher`)),
      };
    });
}

export function loadFixture(name: string): Fixture {
  const dir = path.join(FIXTURES_DIR, name);
  const operations = loadOperations(name, path.join(dir, "operations"));
  return {
    name,
    dir,
    typeDefs: readFileSync(path.join(dir, "typeDefs.graphql"), "utf8"),
    seed: readFileSync(path.join(dir, "seed.cypher"), "utf8"),
    resolversPath: existsSync(path.join(dir, "resolvers.ts"))
      ? path.join(dir, "resolvers.ts")
      : undefined,
    operations,
  };
}

/**
 * Loads every fixture, or only the named ones. `COMPAT_FIXTURES` (comma-separated) restricts the
 * default set, e.g. the CI job that runs the subscription fixtures on Neo4j Enterprise.
 */
export function loadFixtures(
  only: string[] = (process.env.COMPAT_FIXTURES ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
): Fixture[] {
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

/** `printSchema` output without sorting: the contract applications commit and diff in CI. */
export function goldenPrintedSchemaPath(fixture: string): string {
  return path.join(GOLDEN_DIR, fixture, "schema.print.graphql");
}

export function goldenResultPath(fixture: string, operation: string): string {
  return path.join(GOLDEN_DIR, fixture, `${operation}.json`);
}
