/**
 * Schema drift detection for `cyphra migrate status`: compare the constraints and indexes that
 * exist in the database with the ones the applied migrations created.
 *
 * - The **expected** state is rebuilt by replaying the DDL of the applied migrations, in order
 *   ({@link replayMigrations}): each migration's `up()` runs against a recording `db` handle that
 *   never touches the database, and its `CREATE` / `DROP` statements are applied to an in-memory
 *   model ({@link expectedSchemaFromStatements}).
 * - The **actual** state comes from `SHOW CONSTRAINTS` / `SHOW INDEXES` ({@link readSchemaObjects}).
 * - {@link compareSchemaObjects} reports objects that are extra, missing or defined differently.
 *
 * Token lookup indexes, indexes backing a constraint (reported through the constraint) and
 * Cyphra's own `__CyphraMigration` bookkeeping are ignored on both sides.
 *
 * @packageDocumentation
 */

import { toNative, type CyphraClient } from "@cyphra/runtime";
import type { SchemaModel } from "@cyphra/schema";
import { ddlObjectsFromModel } from "./diff.js";
import type { LoadedMigration } from "./runner.js";
import type { MigrationDb } from "./migrationDb.js";
import { CYPHRA_MIGRATION_LABEL } from "./tracker.js";

/** Value of a compared option (vector dimensions, analyzer, …). */
export type SchemaOptionValue = string | number | boolean;

/** A constraint or index, normalized so both sides compare equal when they mean the same thing. */
export type SchemaObject = {
  /** `null` for an unnamed `CREATE` in a migration (Neo4j generates the name). */
  readonly name: string | null;
  readonly kind: "constraint" | "index";
  /**
   * Constraints: `UNIQUE`, `KEY`, `EXISTS` (`IS NOT NULL`) or `TYPE` (`IS :: …`).
   * Indexes: `RANGE`, `POINT`, `TEXT`, `VECTOR` or `FULLTEXT`.
   */
  readonly type: string;
  readonly entityType: "NODE" | "RELATIONSHIP";
  readonly labelsOrTypes: readonly string[];
  readonly properties: readonly string[];
  /**
   * Compared settings: `analyzer` and `eventuallyConsistent` (full-text, with Neo4j's defaults
   * filled in), `dimensions`, `similarity` and `quantization` (vector), `propertyType` (type
   * constraints).
   */
  readonly options: Readonly<Record<string, SchemaOptionValue>>;
};

/** One object defined differently in the database and in the migrations. */
export type ChangedSchemaObject = {
  readonly expected: SchemaObject;
  readonly actual: SchemaObject;
  /** Human-readable differences, e.g. `"dimensions: 3 → 4"` (expected → actual). */
  readonly differences: readonly string[];
};

export type DriftReport = {
  /** In the database, not created by the migrations. */
  readonly extra: readonly SchemaObject[];
  /** Created by the migrations, absent from the database. */
  readonly missing: readonly SchemaObject[];
  /** Present on both sides with a different definition (or under another name). */
  readonly changed: readonly ChangedSchemaObject[];
};

/** `true` when the report has no differences. */
export function isDriftFree(report: DriftReport): boolean {
  return report.extra.length === 0 && report.missing.length === 0 && report.changed.length === 0;
}

/** Neo4j's default full-text analyzer, filled in on both sides so an omitted one compares equal. */
const DEFAULT_ANALYZER = "standard-no-stop-words";

// ---------------------------------------------------------------------------
// DDL parsing
// ---------------------------------------------------------------------------

const ID = "(?:`(?:[^`]|``)+`|[A-Za-z_][A-Za-z0-9_]*)";

function unquote(id: string): string {
  return id.startsWith("`") ? id.slice(1, -1).replace(/``/g, "`") : id;
}

/** Result of {@link parseDdlStatement}. */
export type ParsedDdl =
  | { readonly op: "create"; readonly object: SchemaObject; readonly ifNotExists: boolean }
  | { readonly op: "drop"; readonly kind: "constraint" | "index"; readonly name: string }
  /** Looks like constraint / index DDL but is not a form Cyphra understands. */
  | { readonly op: "unsupported"; readonly statement: string };

function stripComments(text: string): string {
  return text
    .split("\n")
    .map((l) => l.replace(/^\s*\/\/.*$/, ""))
    .join("\n")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .trim()
    .replace(/;\s*$/, "")
    .replace(/\s+/g, " ");
}

/** `n.a, n.\`b\`` → `["a", "b"]` (properties of `variable`). */
function propertyList(text: string, variable: string): string[] | null {
  const parts = text
    .split(/,(?=(?:[^`]*`[^`]*`)*[^`]*$)/)
    .map((p) => p.trim())
    .filter(Boolean);
  const out: string[] = [];
  const re = new RegExp(`^(${ID})\\s*\\.\\s*(${ID})$`);
  for (const p of parts) {
    const m = re.exec(p);
    if (!m || unquote(m[1]!) !== variable) return null;
    out.push(unquote(m[2]!));
  }
  return out.length ? out : null;
}

function normalizeTypeName(t: string): string {
  return t
    .toUpperCase()
    .replace(/\s+/g, " ")
    .replace(/\bINT\b/g, "INTEGER")
    .replace(/\bBOOL\b/g, "BOOLEAN")
    .replace(/\bSIGNED INTEGER\b/g, "INTEGER")
    .replace(/\bTIMESTAMP WITH TIME ZONE\b/g, "ZONED DATETIME")
    .replace(/\bTIMESTAMP WITHOUT TIME ZONE\b/g, "LOCAL DATETIME")
    .trim();
}

/** Options Cyphra compares, read from an `OPTIONS { indexConfig: … }` literal. */
function optionsFromLiteral(type: string, literal: string): Record<string, SchemaOptionValue> {
  const pick = (key: string, value: string) =>
    new RegExp("`?" + key.replace(/\./g, "\\.") + "`?\\s*:\\s*" + value, "i").exec(literal)?.[1];
  const out: Record<string, SchemaOptionValue> = {};
  if (type === "VECTOR") {
    const dims = pick("vector.dimensions", "(\\d+)");
    if (dims) out.dimensions = Number(dims);
    const sim = pick("vector.similarity_function", "['\"]([A-Za-z_]+)['\"]");
    if (sim) out.similarity = sim.toLowerCase();
    const quant = pick("vector.quantization.enabled", "(true|false)");
    if (quant) out.quantization = quant.toLowerCase() === "true";
  } else if (type === "FULLTEXT") {
    out.analyzer = pick("fulltext.analyzer", "['\"]([^'\"]+)['\"]") ?? DEFAULT_ANALYZER;
    const ec = pick("fulltext.eventually_consistent", "(true|false)");
    out.eventuallyConsistent = ec ? ec.toLowerCase() === "true" : false;
  }
  return out;
}

/**
 * Parse one constraint / index DDL statement (Neo4j 5 syntax): `CREATE [RANGE|POINT|TEXT|VECTOR|
 * FULLTEXT] INDEX`, `CREATE CONSTRAINT … REQUIRE … IS [NODE|RELATIONSHIP] UNIQUE | KEY | NOT NULL |
 * :: TYPE`, `DROP INDEX|CONSTRAINT name`.
 *
 * @returns `null` when the statement is not constraint / index DDL (data statements).
 */
export function parseDdlStatement(statement: string): ParsedDdl | null {
  const text = stripComments(statement);
  const drop = new RegExp(`^DROP (INDEX|CONSTRAINT) (${ID})(?: IF EXISTS)?$`, "i").exec(text);
  if (drop) {
    return {
      op: "drop",
      kind: drop[1]!.toLowerCase() as "index" | "constraint",
      name: unquote(drop[2]!),
    };
  }
  if (!/^(CREATE|DROP)\b(?: [A-Z]+)? (INDEX|CONSTRAINT)\b/i.test(text)) return null;
  const unsupported = { op: "unsupported", statement: text } as const;

  const head = new RegExp(
    `^CREATE (?:(RANGE|POINT|TEXT|VECTOR|FULLTEXT) )?(INDEX|CONSTRAINT)(?: (?!IF\\b|FOR\\b)(${ID}))?( IF NOT EXISTS)? FOR (.*)$`,
    "i",
  ).exec(text);
  if (!head) return unsupported;
  const kind = head[2]!.toLowerCase() as "index" | "constraint";
  const name = head[3] ? unquote(head[3]) : null;
  const ifNotExists = Boolean(head[4]);
  let rest = head[5]!;

  // Target: (n:Label) / (n:A|B) or ()-[r:TYPE]-() (any direction).
  const node = new RegExp(`^\\(\\s*(${ID})\\s*:\\s*(${ID}(?:\\s*\\|\\s*${ID})*)\\s*\\)\\s*`).exec(
    rest,
  );
  const rel = new RegExp(
    `^\\(\\s*\\)\\s*<?-\\s*\\[\\s*(${ID})\\s*:\\s*(${ID}(?:\\s*\\|\\s*${ID})*)\\s*\\]\\s*->?\\s*\\(\\s*\\)\\s*`,
  ).exec(rest);
  const target = node ?? rel;
  if (!target) return unsupported;
  const variable = unquote(target[1]!);
  const entityType = node ? "NODE" : "RELATIONSHIP";
  let labels = target[2]!.split("|").map((l) => unquote(l.trim()));
  rest = rest.slice(target[0].length);

  let options: Record<string, SchemaOptionValue>;
  let type: string;
  let properties: string[] | null;
  if (kind === "index") {
    type = (head[1] ?? "RANGE").toUpperCase();
    const on =
      type === "FULLTEXT"
        ? /^ON EACH \[(.*?)\]\s*(?:OPTIONS (.*))?$/i.exec(rest)
        : /^ON (?:\((.*?)\)|([^ ]+))\s*(?:OPTIONS (.*))?$/i.exec(rest);
    if (!on) return unsupported;
    properties = propertyList((on[1] ?? on[2])!, variable);
    options = optionsFromLiteral(type, (type === "FULLTEXT" ? on[2] : on[3]) ?? "");
    if (type === "FULLTEXT") labels = [...labels].sort();
  } else {
    const req =
      /^REQUIRE (?:\((.*?)\)|([^ ]+)) IS (?:(NODE |RELATIONSHIP )?(UNIQUE|KEY)|(NOT NULL)|(?:::|TYPED) (.+?))\s*(?:OPTIONS (.*))?$/i.exec(
        rest,
      );
    if (!req) return unsupported;
    properties = propertyList((req[1] ?? req[2])!, variable);
    options = {};
    if (req[4]) type = req[4].toUpperCase();
    else if (req[5]) type = "EXISTS";
    else {
      type = "TYPE";
      options.propertyType = normalizeTypeName(req[6]!);
    }
  }
  if (!properties) return unsupported;
  return {
    op: "create",
    ifNotExists,
    object: { name, kind, type, entityType, labelsOrTypes: labels, properties, options },
  };
}

// ---------------------------------------------------------------------------
// Expected state
// ---------------------------------------------------------------------------

function isInternal(o: SchemaObject): boolean {
  return (
    o.name === "cyphra_migration_name_unique" ||
    (o.name?.startsWith("__") ?? false) ||
    o.labelsOrTypes.some((l) => l === CYPHRA_MIGRATION_LABEL || l.startsWith("__"))
  );
}

/** Identity of a definition, ignoring the name and the compared options. */
function signature(o: SchemaObject): string {
  return JSON.stringify([o.kind, o.type, o.entityType, o.labelsOrTypes, o.properties]);
}

/**
 * Apply DDL statements, in order, to an empty model: `CREATE … IF NOT EXISTS` is a no-op when an
 * object with that name (or an equivalent definition) exists, `DROP` removes the named object.
 *
 * @param statements - Cypher statements (data statements are ignored).
 * @returns Resulting objects, plus warnings for DDL that could not be interpreted.
 */
export function expectedSchemaFromStatements(statements: readonly string[]): {
  objects: SchemaObject[];
  warnings: string[];
} {
  const objects: SchemaObject[] = [];
  const warnings: string[] = [];
  for (const s of statements) {
    const parsed = parseDdlStatement(s);
    if (!parsed) continue;
    if (parsed.op === "unsupported") {
      warnings.push(`Could not interpret DDL, ignored for drift detection: ${parsed.statement}`);
      continue;
    }
    if (parsed.op === "drop") {
      const i = objects.findIndex((o) => o.name === parsed.name);
      if (i >= 0) objects.splice(i, 1);
      continue;
    }
    const o = parsed.object;
    if (isInternal(o)) continue;
    const byName = o.name === null ? -1 : objects.findIndex((x) => x.name === o.name);
    const equivalent = objects.findIndex((x) => signature(x) === signature(o));
    if (parsed.ifNotExists && (byName >= 0 || equivalent >= 0)) continue;
    if (byName >= 0) objects.splice(byName, 1);
    objects.push(o);
  }
  return { objects, warnings };
}

/**
 * A {@link MigrationDb} that records statements instead of running them. Reads return no rows,
 * so guards pass and data loops do nothing.
 */
function recordingDb(statements: string[]): MigrationDb {
  return {
    async run(strings: TemplateStringsArray) {
      // Values become parameters: DDL has none, data statements are ignored.
      statements.push(strings.reduce((acc, s, i) => acc + (i > 0 ? `$p${i - 1}` : "") + s, ""));
    },
    async runInTransactionBatches() {},
    async execute(text: string) {
      statements.push(text);
      return [];
    },
    migrate: {
      async renameLabel() {},
      async renameProperty() {},
    },
  };
}

/**
 * Rebuild the constraints and indexes the given migrations create, by running each `up()`
 * against a recording `db` handle (nothing reaches the database).
 *
 * @param migrations - Applied migrations, in the order they were applied.
 * @returns Expected objects and warnings (migrations whose `up()` threw, unparseable DDL).
 */
export async function replayMigrations(
  migrations: readonly LoadedMigration[],
): Promise<{ objects: SchemaObject[]; warnings: string[] }> {
  const statements: string[] = [];
  const warnings: string[] = [];
  for (const m of migrations) {
    try {
      await m.definition.up({ db: recordingDb(statements) });
    } catch (err) {
      warnings.push(
        `Migration ${m.name} could not be replayed (${err instanceof Error ? err.message : String(err)}); the DDL it ran before failing is used.`,
      );
    }
  }
  const result = expectedSchemaFromStatements(statements);
  return { objects: result.objects, warnings: [...warnings, ...result.warnings] };
}

/**
 * The constraints and indexes a schema model implies (what `cyphra push` creates), for comparing a
 * database with `schema.cyphra` instead of the migrations.
 */
export function expectedSchemaFromModel(model: SchemaModel): SchemaObject[] {
  return expectedSchemaFromStatements(ddlObjectsFromModel(model).map((o) => o.create)).objects;
}

// ---------------------------------------------------------------------------
// Actual state
// ---------------------------------------------------------------------------

/** A row of `SHOW CONSTRAINTS YIELD *` or `SHOW INDEXES YIELD *`, as plain values. */
export type ShowRow = Readonly<Record<string, unknown>>;

function constraintType(raw: string): string {
  const t = raw.toUpperCase();
  if (t.includes("UNIQUE")) return "UNIQUE";
  if (t.includes("KEY")) return "KEY";
  if (t.includes("EXISTENCE")) return "EXISTS";
  if (t.includes("TYPE")) return "TYPE";
  return t;
}

/**
 * Normalize `SHOW CONSTRAINTS` / `SHOW INDEXES` rows. Drops token lookup indexes, indexes owned by
 * a constraint, and Cyphra's bookkeeping constraint.
 */
export function schemaObjectsFromShow(
  constraints: readonly ShowRow[],
  indexes: readonly ShowRow[],
): SchemaObject[] {
  const out: SchemaObject[] = [];
  const list = (v: unknown) => (Array.isArray(v) ? v.map(String) : []);
  for (const c of constraints) {
    const options: Record<string, SchemaOptionValue> = {};
    if (typeof c.propertyType === "string") {
      options.propertyType = normalizeTypeName(c.propertyType);
    }
    out.push({
      name: String(c.name),
      kind: "constraint",
      type: constraintType(String(c.type)),
      entityType: c.entityType === "RELATIONSHIP" ? "RELATIONSHIP" : "NODE",
      labelsOrTypes: list(c.labelsOrTypes),
      properties: list(c.properties),
      options,
    });
  }
  for (const i of indexes) {
    const type = String(i.type).toUpperCase();
    if (type === "LOOKUP" || i.owningConstraint) continue;
    const config =
      ((i.options ?? {}) as { indexConfig?: Record<string, unknown> }).indexConfig ?? {};
    const options: Record<string, SchemaOptionValue> = {};
    if (type === "VECTOR") {
      const dims = config["vector.dimensions"];
      if (dims !== undefined && dims !== null) options.dimensions = Number(dims);
      const sim = config["vector.similarity_function"];
      if (sim) options.similarity = String(sim).toLowerCase();
      const quant = config["vector.quantization.enabled"];
      if (typeof quant === "boolean") options.quantization = quant;
    } else if (type === "FULLTEXT") {
      options.analyzer = String(config["fulltext.analyzer"] ?? DEFAULT_ANALYZER);
      options.eventuallyConsistent = config["fulltext.eventually_consistent"] === true;
    }
    const labels = list(i.labelsOrTypes);
    out.push({
      name: String(i.name),
      kind: "index",
      type,
      entityType: i.entityType === "RELATIONSHIP" ? "RELATIONSHIP" : "NODE",
      labelsOrTypes: type === "FULLTEXT" ? [...labels].sort() : labels,
      properties: list(i.properties),
      options,
    });
  }
  return out.filter((o) => !isInternal(o));
}

/** Read the database's constraints and indexes (read-only, no data sampling). */
export async function readSchemaObjects(client: CyphraClient): Promise<SchemaObject[]> {
  return client.withSession(async (session) => {
    const rows = async (text: string) =>
      (await session.run(text)).records.map((r) => toNative(r.toObject()) as ShowRow);
    return schemaObjectsFromShow(
      await rows("SHOW CONSTRAINTS YIELD *"),
      await rows("SHOW INDEXES YIELD *"),
    );
  });
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

function differences(expected: SchemaObject, actual: SchemaObject): string[] {
  const diffs: string[] = [];
  const show = (v: readonly string[]) => v.join(", ");
  if (expected.name !== null && expected.name !== actual.name) {
    diffs.push(`name: ${expected.name} → ${actual.name}`);
  }
  if (expected.kind !== actual.kind) diffs.push(`kind: ${expected.kind} → ${actual.kind}`);
  if (expected.type !== actual.type) diffs.push(`type: ${expected.type} → ${actual.type}`);
  if (expected.entityType !== actual.entityType) {
    diffs.push(`entity: ${expected.entityType} → ${actual.entityType}`);
  }
  if (show(expected.labelsOrTypes) !== show(actual.labelsOrTypes)) {
    const what = expected.entityType === "NODE" ? "labels" : "relationship types";
    diffs.push(`${what}: ${show(expected.labelsOrTypes)} → ${show(actual.labelsOrTypes)}`);
  }
  if (show(expected.properties) !== show(actual.properties)) {
    diffs.push(`properties: ${show(expected.properties)} → ${show(actual.properties)}`);
  }
  // Only settings the migrations state (or that have a known default) are compared.
  for (const [key, value] of Object.entries(expected.options)) {
    const got = actual.options[key];
    if (got !== value) diffs.push(`${key}: ${value} → ${got ?? "(not set)"}`);
  }
  return diffs;
}

/**
 * Compare expected (from migrations or the schema) and actual (from the database) objects.
 * Objects are matched by name; unnamed expected objects, and objects left over on both sides
 * with the same definition, are matched by definition.
 */
export function compareSchemaObjects(
  expected: readonly SchemaObject[],
  actual: readonly SchemaObject[],
): DriftReport {
  const changed: ChangedSchemaObject[] = [];
  const leftExpected: SchemaObject[] = [];
  const leftActual = new Map(actual.map((a) => [a.name!, a]));
  for (const e of expected) {
    const a = e.name === null ? undefined : leftActual.get(e.name);
    if (!a) {
      leftExpected.push(e);
      continue;
    }
    leftActual.delete(a.name!);
    const diffs = differences(e, a);
    if (diffs.length) changed.push({ expected: e, actual: a, differences: diffs });
  }
  const missing: SchemaObject[] = [];
  for (const e of leftExpected) {
    const a = [...leftActual.values()].find((x) => signature(x) === signature(e));
    if (!a) {
      missing.push(e);
      continue;
    }
    leftActual.delete(a.name!);
    const diffs = differences(e, a);
    if (diffs.length) changed.push({ expected: e, actual: a, differences: diffs });
  }
  return { extra: [...leftActual.values()], missing, changed };
}

/** One-line description, e.g. `VECTOR index on (:Doc {embedding}) dimensions=3`. */
export function describeSchemaObject(o: SchemaObject): string {
  const target =
    o.entityType === "NODE"
      ? `(:${o.labelsOrTypes.join("|")} {${o.properties.join(", ")}})`
      : `()-[:${o.labelsOrTypes.join("|")} {${o.properties.join(", ")}}]-()`;
  const opts = Object.entries(o.options)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
  return `${o.type} ${o.kind} on ${target}${opts ? ` ${opts}` : ""}`;
}

/**
 * Compare the database with the constraints and indexes the given (applied) migrations create.
 *
 * @param client - Cyphra client (only `SHOW CONSTRAINTS` / `SHOW INDEXES` run against it).
 * @param applied - Applied migrations, in the order they were applied.
 */
export async function detectDrift(
  client: CyphraClient,
  applied: readonly LoadedMigration[],
): Promise<{ report: DriftReport; warnings: string[] }> {
  const { objects, warnings } = await replayMigrations(applied);
  return { report: compareSchemaObjects(objects, await readSchemaObjects(client)), warnings };
}
