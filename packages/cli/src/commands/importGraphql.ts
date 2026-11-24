import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  GraphQLImportError,
  convertGraphQLTypeDefs,
  formatImportReport,
  mergeImportedSchema,
  printImportedSchema,
  type UniquenessConstraint,
} from "@cyphra/graphql";
import { readSchemaObjects } from "@cyphra/migrator";
import { CyphraClient, detectDialect } from "@cyphra/runtime";
import { clientForConfig, falkordbGraphFromEnv } from "../clientFromEnv.js";
import { loadConfig } from "../config.js";
import { exists, writeImportedSchema, type ImportOutputOptions } from "./importOutput.js";

export type ImportGraphqlOptions = ImportOutputOptions & {
  /**
   * Read the database's uniqueness constraints to mark the fields they cover `@id` / `@unique`:
   * a Bolt (or `redis://` for FalkorDB) URI, or `true` for the environment (`NEO4J_URI`, …, like
   * `cyphra pull`).
   */
  url?: string | true;
  /** `Type.field` hints for fields to mark `@id` (no database needed). */
  idFields?: readonly string[];
  /** Map GraphQL interfaces whose implementations do not carry the label yet. */
  addInterfaceLabels?: boolean;
};

/**
 * A client for `--url`: the environment (and the dialect of cyphra.json) like `cyphra pull`, or the
 * given URI with the credentials of its user info or of `NEO4J_USERNAME` / `NEO4J_PASSWORD`.
 */
async function connect(cwd: string, url: string | true): Promise<CyphraClient> {
  if (url === true) {
    const config = (await exists(path.join(cwd, "cyphra.json"))) ? await loadConfig(cwd) : {};
    return clientForConfig(config);
  }
  if (/^rediss?:\/\//i.test(url)) {
    return new CyphraClient({ falkordb: { url, graph: falkordbGraphFromEnv() } });
  }
  let uri = url;
  let user = process.env.NEO4J_USERNAME || process.env.NEO4J_USER;
  let password = process.env.NEO4J_PASSWORD;
  try {
    const parsed = new URL(url);
    if (parsed.username) {
      user = decodeURIComponent(parsed.username);
      password = decodeURIComponent(parsed.password);
      parsed.username = "";
      parsed.password = "";
      uri = parsed.toString();
    }
  } catch {
    // Not a URL: the driver reports it.
  }
  if (!user || password === undefined) {
    throw new Error(
      "Give the credentials in the URL (bolt://user:password@host) or set NEO4J_USERNAME and NEO4J_PASSWORD",
    );
  }
  const options = { uri, user, password, database: process.env.NEO4J_DATABASE };
  const client = new CyphraClient(options);
  const dialect = await detectDialect(client).catch(() => "neo4j" as const);
  if (dialect !== "memgraph") return client;
  await client.close();
  return new CyphraClient({ ...options, dialect });
}

/**
 * The node uniqueness constraints and node keys of the database (read-only: `SHOW CONSTRAINTS`).
 */
export async function readUniquenessConstraints(
  cwd: string,
  url: string | true,
): Promise<UniquenessConstraint[]> {
  const client = await connect(cwd, url);
  try {
    const objects = await readSchemaObjects(client);
    return objects.flatMap((o): UniquenessConstraint[] => {
      if (o.kind !== "constraint" || o.entityType !== "NODE") return [];
      if ((o.type !== "UNIQUE" && o.type !== "KEY") || o.labelsOrTypes.length !== 1) return [];
      const label = o.labelsOrTypes[0]!;
      return [
        {
          name: o.name ?? `${label}(${o.properties.join(", ")})`,
          label,
          properties: o.properties,
          type: o.type,
        },
      ];
    });
  } finally {
    await client.close();
  }
}

/**
 * `cyphra import graphql <files…>`: convert `@neo4j/graphql` v7 type definitions to
 * `schema.cyphra` and print a report of what was not converted. With `--url`, the database's
 * uniqueness constraints mark the fields they cover `@id` / `@unique`.
 *
 * @returns The process exit code: `0` when the schema was written (even with warnings), `1` when
 * the type definitions are invalid, the database cannot be read or the output cannot be written.
 */
export async function runImportGraphql(
  cwd: string,
  files: readonly string[],
  opts: ImportGraphqlOptions = {},
): Promise<number> {
  if (opts.merge && opts.force) {
    console.error("Pass either --merge or --force, not both.");
    return 1;
  }
  const sources = [];
  for (const f of files) {
    const abs = path.resolve(cwd, f);
    try {
      sources.push({ name: path.relative(cwd, abs) || f, body: await readFile(abs, "utf8") });
    } catch {
      console.error(`Cannot read ${f}.`);
      return 1;
    }
  }

  let constraints: UniquenessConstraint[] | undefined;
  if (opts.url) {
    try {
      constraints = await readUniquenessConstraints(cwd, opts.url);
    } catch (err) {
      console.error(
        `Cannot read the database's constraints: ${err instanceof Error ? err.message : String(err)}`,
      );
      return 1;
    }
  }

  let result;
  try {
    result = convertGraphQLTypeDefs(sources, {
      ...(constraints ? { constraints } : {}),
      ...(opts.idFields?.length ? { idFields: opts.idFields } : {}),
      ...(opts.addInterfaceLabels ? { addInterfaceLabels: true } : {}),
    });
  } catch (err) {
    if (err instanceof GraphQLImportError) {
      console.error(`Invalid type definitions: ${err.message}`);
      return 1;
    }
    throw err;
  }
  return writeImportedSchema(cwd, result, opts, {
    print: printImportedSchema,
    merge: mergeImportedSchema,
    report: formatImportReport,
  });
}
