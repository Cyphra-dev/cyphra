/**
 * FalkorDB DDL: the constraints and indexes Cyphra creates, in FalkorDB's syntax, and FalkorDB's
 * schema objects read back for drift detection, `cyphra pull` and `cyphra migrate reset`.
 *
 * Cyphra builds every statement in Neo4j's syntax first (`push.ts`, `diff.ts`); for the
 * `"falkordb"` dialect, {@link falkordbDdl} parses it ({@link parseDdlStatement}) and writes the
 * FalkorDB equivalent, with the statement that drops it (FalkorDB's constraints and indexes have
 * no name: they are dropped by definition).
 *
 * | Neo4j                                                         | FalkorDB                                                       |
 * | ------------------------------------------------------------- | -------------------------------------------------------------- |
 * | `CREATE CONSTRAINT … FOR (n:L) REQUIRE (n.a, n.b) IS UNIQUE`  | `GRAPH.CONSTRAINT CREATE UNIQUE NODE L PROPERTIES 2 a b`       |
 * | `CREATE CONSTRAINT … FOR ()-[r:T]-() REQUIRE r.p IS UNIQUE`   | `GRAPH.CONSTRAINT CREATE UNIQUE RELATIONSHIP T PROPERTIES 1 p` |
 * | `CREATE CONSTRAINT … REQUIRE n.p IS NOT NULL`                 | `GRAPH.CONSTRAINT CREATE MANDATORY NODE L PROPERTIES 1 p`      |
 * | `CREATE RANGE INDEX … FOR (n:L) ON (n.a, n.b)`                | `CREATE INDEX FOR (n:L) ON (n.a, n.b)`                         |
 * | `CREATE VECTOR INDEX … OPTIONS {indexConfig: …}`              | `CREATE VECTOR INDEX FOR (n:L) ON (n.p) OPTIONS {dimension: …}` |
 * | `CREATE FULLTEXT INDEX … ON EACH [n.a, n.b]`                  | `CREATE FULLTEXT INDEX FOR (n:L) ON (n.a, n.b)`                |
 *
 * `GRAPH.CONSTRAINT …` is a Redis command, not Cypher: the FalkorDB transport of
 * `@cyphra/runtime` runs it (creating the range indexes a unique constraint needs first). FalkorDB
 * indexes one property at a time (a composite range index is one index per property) and has one
 * full-text index per label; it has no `IF [NOT] EXISTS`, so {@link runFalkorDBDdl} treats "already
 * indexed / exists" on create and "no such index / constraint" on drop as done. It has no point
 * indexes, no type constraints, no full-text analyzers and no vector quantization setting.
 *
 * @packageDocumentation
 */

import { UnsupportedFeatureError, toNative, type CyphraClient } from "@cyphra/runtime";
import { parseDdlStatement, type SchemaObject } from "./drift.js";
import { CYPHRA_MIGRATION_LABEL } from "./tracker.js";

function q(id: string): string {
  return "`" + id.replace(/`/g, "``") + "`";
}

function unsupported(feature: string, hint?: string): UnsupportedFeatureError {
  return new UnsupportedFeatureError(feature, "falkordb", hint);
}

function describe(o: SchemaObject): string {
  const props = o.properties.join(", ");
  return o.entityType === "NODE"
    ? `(:${o.labelsOrTypes.join("|")} {${props}})`
    : `()-[:${o.labelsOrTypes.join("|")} {${props}}]-()`;
}

/** `FOR (n:L) ON (n.a, n.b)` / `FOR ()-[r:T]-() ON (r.p)`. */
function target(o: SchemaObject, properties: readonly string[] = o.properties): string {
  const label = q(o.labelsOrTypes[0]!);
  const v = o.entityType === "NODE" ? "n" : "r";
  const pattern = o.entityType === "NODE" ? `(n:${label})` : `()-[r:${label}]-()`;
  return `FOR ${pattern} ON (${properties.map((p) => `${v}.${q(p)}`).join(", ")})`;
}

/** FalkorDB's vector similarity function for a Cyphra / Neo4j one. */
export function falkordbVectorSimilarity(similarity: string): "cosine" | "euclidean" {
  return similarity === "euclidean" ? "euclidean" : "cosine";
}

/** The `CREATE` and `DROP` statements of a schema object on FalkorDB (see the module table). */
export function falkordbStatements(o: SchemaObject): { create: string; drop: string } {
  if (o.labelsOrTypes.length !== 1) {
    throw unsupported(
      `A ${o.type.toLowerCase()} ${o.kind} on several labels ${describe(o)}`,
      "FalkorDB indexes and constraints cover one label (or relationship type).",
    );
  }
  if (o.properties.length === 0) {
    throw unsupported(`A ${o.type.toLowerCase()} ${o.kind} without properties ${describe(o)}`);
  }
  if (o.kind === "constraint") {
    let type: string;
    if (o.type === "UNIQUE") type = "UNIQUE";
    else if (o.type === "EXISTS") type = "MANDATORY";
    else {
      throw unsupported(
        `A ${o.type === "TYPE" ? "property type" : o.type.toLowerCase()} constraint ${describe(o)}`,
        "FalkorDB has unique and mandatory (NOT NULL) constraints only.",
      );
    }
    const body = `${type} ${o.entityType === "NODE" ? "NODE" : "RELATIONSHIP"} ${q(o.labelsOrTypes[0]!)} PROPERTIES ${o.properties.length} ${o.properties.map(q).join(" ")}`;
    return { create: `GRAPH.CONSTRAINT CREATE ${body}`, drop: `GRAPH.CONSTRAINT DROP ${body}` };
  }
  switch (o.type) {
    case "RANGE":
      return { create: `CREATE INDEX ${target(o)}`, drop: `DROP INDEX ${target(o)}` };
    case "FULLTEXT":
      if (o.entityType === "RELATIONSHIP") {
        throw unsupported(`A full-text index on relationships ${describe(o)}`);
      }
      return {
        create: `CREATE FULLTEXT INDEX ${target(o)}`,
        drop: `DROP FULLTEXT INDEX ${target(o)}`,
      };
    case "VECTOR": {
      if (o.properties.length !== 1) throw unsupported(`A composite vector index ${describe(o)}`);
      const fn = falkordbVectorSimilarity(String(o.options.similarity ?? "cosine"));
      return {
        create: `CREATE VECTOR INDEX ${target(o)} OPTIONS {dimension: ${Number(o.options.dimensions)}, similarityFunction: '${fn}'}`,
        drop: `DROP VECTOR INDEX ${target(o)}`,
      };
    }
    case "POINT":
      throw unsupported(
        `A point index ${describe(o)}`,
        "FalkorDB has no point indexes (and Point fields are not supported on FalkorDB).",
      );
    default:
      throw unsupported(`A ${o.type} index ${describe(o)}`);
  }
}

/**
 * A Cyphra DDL statement in Neo4j syntax as FalkorDB statements, or `null` for anything that is
 * not constraint / index creation (data statements, or a statement already in FalkorDB's syntax).
 *
 * @throws {UnsupportedFeatureError} For DDL FalkorDB has no equivalent of (point indexes, type
 *   constraints, …).
 */
export function falkordbDdl(statement: string): { create: string; drop: string } | null {
  if (isFalkorDBDdl(statement)) return null;
  const parsed = parseDdlStatement(statement);
  if (!parsed || parsed.op !== "create") return null;
  return falkordbStatements(parsed.object);
}

/**
 * Whether `statement` is DDL in FalkorDB's syntax: `GRAPH.CONSTRAINT …`, or an unnamed `CREATE |
 * DROP [FULLTEXT | VECTOR] INDEX FOR … ON (…)` (without Neo4j's `IF NOT EXISTS`, `ON EACH` or
 * `indexConfig`).
 */
export function isFalkorDBDdl(statement: string): boolean {
  const text = statement.trim();
  if (/^GRAPH\.CONSTRAINT\s/i.test(text)) return true;
  return (
    /^(CREATE|DROP)\s+(?:(?:FULLTEXT|VECTOR)\s+)?INDEX\s+FOR\s/i.test(text) &&
    !/\bON\s+EACH\b|indexConfig/i.test(text)
  );
}

// ---------------------------------------------------------------------------
// Parsing FalkorDB DDL (for drift detection on migrations written for FalkorDB)
// ---------------------------------------------------------------------------

const ID = "(?:`(?:[^`]|``)+`|[A-Za-z_][A-Za-z0-9_]*)";

function unquote(id: string): string {
  return id.startsWith("`") ? id.slice(1, -1).replace(/``/g, "`") : id;
}

/** Result of {@link parseFalkorDBDdl}: the object a statement creates or drops. */
export type ParsedFalkorDBDdl = {
  readonly op: "create" | "drop";
  readonly object: SchemaObject;
};

/**
 * Parse one FalkorDB constraint / index statement (the forms {@link falkordbStatements} writes),
 * or `null` when it is not FalkorDB-only DDL. A plain `CREATE INDEX FOR (n:L) ON (n.p)` is also
 * Neo4j syntax: it is left to the Neo4j parser (same object).
 */
export function parseFalkorDBDdl(statement: string): ParsedFalkorDBDdl | null {
  const text = statement.trim().replace(/;\s*$/, "").replace(/\s+/g, " ");
  const constraint = new RegExp(
    `^GRAPH\\.CONSTRAINT (CREATE|DROP) (UNIQUE|MANDATORY) (NODE|RELATIONSHIP) (${ID}) PROPERTIES (\\d+) (.+)$`,
    "i",
  ).exec(text);
  if (constraint) {
    const props = (constraint[6]!.match(new RegExp(ID, "g")) ?? []).map(unquote);
    if (props.length !== Number(constraint[5])) return null;
    return {
      op: constraint[1]!.toLowerCase() as "create" | "drop",
      object: {
        name: null,
        kind: "constraint",
        type: constraint[2]!.toUpperCase() === "UNIQUE" ? "UNIQUE" : "EXISTS",
        entityType: constraint[3]!.toUpperCase() === "NODE" ? "NODE" : "RELATIONSHIP",
        labelsOrTypes: [unquote(constraint[4]!)],
        properties: props,
        options: {},
      },
    };
  }
  if (!isFalkorDBDdl(text)) return null;
  const index = new RegExp(
    `^(CREATE|DROP) (?:(FULLTEXT|VECTOR) )?INDEX FOR (?:\\(\\s*(${ID})\\s*:\\s*(${ID})\\s*\\)|\\(\\s*\\)\\s*<?-\\s*\\[\\s*(${ID})\\s*:\\s*(${ID})\\s*\\]\\s*->?\\s*\\(\\s*\\)) ON \\((.*?)\\)\\s*(?:OPTIONS (.*))?$`,
    "i",
  ).exec(text);
  if (!index) return null;
  const op = index[1]!.toLowerCase() as "create" | "drop";
  const type = (index[2] ?? "RANGE").toUpperCase();
  // A plain range CREATE is Neo4j syntax too: the Neo4j parser reads it.
  if (op === "create" && type === "RANGE") return null;
  const node = index[3] !== undefined;
  const variable = unquote((node ? index[3] : index[5])!);
  const label = unquote((node ? index[4] : index[6])!);
  const properties: string[] = [];
  for (const p of index[7]!.split(",")) {
    const m = new RegExp(`^\\s*(${ID})\\s*\\.\\s*(${ID})\\s*$`).exec(p);
    if (!m || unquote(m[1]!) !== variable) return null;
    properties.push(unquote(m[2]!));
  }
  const options: Record<string, string | number> = {};
  if (type === "VECTOR" && index[8]) {
    const dims = /dimension\s*:\s*(\d+)/i.exec(index[8])?.[1];
    if (dims) options.dimensions = Number(dims);
    const fn = /similarityFunction\s*:\s*['"]([A-Za-z]+)['"]/i.exec(index[8])?.[1];
    options.similarity = falkordbVectorSimilarity(fn?.toLowerCase() ?? "cosine");
  }
  return {
    op,
    object: {
      name: null,
      kind: "index",
      type,
      entityType: node ? "NODE" : "RELATIONSHIP",
      labelsOrTypes: [label],
      properties: type === "FULLTEXT" ? [...properties].sort() : properties,
      options,
    },
  };
}

// ---------------------------------------------------------------------------
// Normalization (both sides of a drift comparison)
// ---------------------------------------------------------------------------

const key = (o: SchemaObject, props: readonly string[] = o.properties) =>
  JSON.stringify([o.entityType, o.labelsOrTypes, props]);

/**
 * Schema objects as FalkorDB stores them, for comparing what the migrations (or the schema)
 * create with what the database has: unnamed; a composite range index is one range index per
 * property; the full-text indexes of a label are one index on all their (sorted) properties;
 * range indexes on the properties of a unique constraint (which FalkorDB creates with it) are
 * left out; only the vector settings FalkorDB has (dimensions, similarity) are kept.
 */
export function normalizeFalkorDBObjects(objects: readonly SchemaObject[]): SchemaObject[] {
  const out: SchemaObject[] = [];
  const seen = new Set<string>();
  const push = (o: SchemaObject) => {
    const k = JSON.stringify([o.kind, o.type, key(o), o.options]);
    if (seen.has(k)) return;
    seen.add(k);
    out.push(o);
  };
  const constrained = new Set<string>();
  for (const o of objects) {
    if (o.kind === "constraint" && o.type === "UNIQUE") {
      for (const p of o.properties) constrained.add(key(o, [p]));
    }
  }
  const fulltext = new Map<string, SchemaObject>();
  for (const o of objects) {
    const base = { ...o, name: null };
    if (o.kind === "constraint") {
      push({ ...base, properties: [...o.properties].sort(), options: {} });
    } else if (o.type === "RANGE") {
      for (const p of o.properties) {
        if (constrained.has(key(o, [p]))) continue;
        push({ ...base, properties: [p], options: {} });
      }
    } else if (o.type === "FULLTEXT") {
      const k = key(o, []);
      const prev = fulltext.get(k);
      const props = [...new Set([...(prev?.properties ?? []), ...o.properties])].sort();
      fulltext.set(k, { ...base, properties: props, options: {} });
    } else if (o.type === "VECTOR") {
      const options: Record<string, string | number> = {};
      if (o.options.dimensions !== undefined) options.dimensions = Number(o.options.dimensions);
      options.similarity = falkordbVectorSimilarity(String(o.options.similarity ?? "cosine"));
      push({ ...base, options });
    } else {
      push(base);
    }
  }
  for (const o of fulltext.values()) push(o);
  return out;
}

// ---------------------------------------------------------------------------
// Reading FalkorDB's schema objects
// ---------------------------------------------------------------------------

type Row = Readonly<Record<string, unknown>>;

function list(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  return v === null || v === undefined ? [] : [String(v)];
}

/**
 * Schema objects from `CALL db.constraints()` and `CALL db.indexes()` rows, as stored: one range,
 * full-text or vector index per (label, property), including the range indexes that back unique
 * constraints (see {@link normalizeFalkorDBObjects} to compare them).
 */
export function falkordbSchemaObjects(
  constraints: readonly Row[],
  indexes: readonly Row[],
): SchemaObject[] {
  const out: SchemaObject[] = [];
  const entity = (v: unknown): "NODE" | "RELATIONSHIP" =>
    String(v ?? "NODE").toUpperCase() === "NODE" ? "NODE" : "RELATIONSHIP";
  for (const c of constraints) {
    const type = String(c.type ?? "").toUpperCase();
    out.push({
      name: null,
      kind: "constraint",
      type: type === "MANDATORY" ? "EXISTS" : type,
      entityType: entity(c.entitytype),
      labelsOrTypes: [String(c.label)],
      properties: list(c.properties),
      options: {},
    });
  }
  for (const i of indexes) {
    const label = String(i.label);
    const types = (i.types ?? {}) as Record<string, unknown>;
    const options = (i.options ?? {}) as Record<string, unknown>;
    const fulltext: string[] = [];
    for (const p of list(i.properties)) {
      for (const t of list(types[p])) {
        const kind = t.toUpperCase();
        if (kind === "FULLTEXT") {
          fulltext.push(p);
          continue;
        }
        const opts: Record<string, string | number> = {};
        if (kind === "VECTOR") {
          const o = (options[p] ?? {}) as Record<string, unknown>;
          if (o.dimension !== undefined) opts.dimensions = Number(o.dimension);
          opts.similarity = falkordbVectorSimilarity(
            String(o.similarityFunction ?? "cosine").toLowerCase(),
          );
        }
        out.push({
          name: null,
          kind: "index",
          type: kind,
          entityType: entity(i.entitytype),
          labelsOrTypes: [label],
          properties: [p],
          options: opts,
        });
      }
    }
    if (fulltext.length) {
      out.push({
        name: null,
        kind: "index",
        type: "FULLTEXT",
        entityType: entity(i.entitytype),
        labelsOrTypes: [label],
        properties: fulltext.sort(),
        options: {},
      });
    }
  }
  return out;
}

/** The FalkorDB schema objects of `client`'s graph, as stored (Cyphra's bookkeeping included). */
export async function readFalkorDBSchemaObjects(client: CyphraClient): Promise<SchemaObject[]> {
  return client.withSession(async (session) => {
    const rows = async (text: string) =>
      (await session.run(text)).records.map((r) => toNative(r.toObject()) as Row);
    return falkordbSchemaObjects(
      await rows(
        "CALL db.constraints() YIELD type, label, properties, entitytype RETURN type, label, properties, entitytype",
      ),
      await rows(
        "CALL db.indexes() YIELD label, properties, types, options, entitytype RETURN label, properties, types, options, entitytype",
      ),
    );
  });
}

// ---------------------------------------------------------------------------
// Running DDL
// ---------------------------------------------------------------------------

/**
 * `statement` as the statements to run: a range or full-text `CREATE | DROP … INDEX FOR … ON (a, b)`
 * on several properties becomes one statement per property (FalkorDB creates them all or none,
 * failing when one is already indexed, and drops only the first); anything else is returned as is.
 */
export function falkordbExecutable(statement: string): string[] {
  const parsed = parseFalkorDBDdl(statement) ?? createRange(statement);
  const type = parsed?.object.type;
  if (!parsed || parsed.object.kind !== "index" || (type !== "RANGE" && type !== "FULLTEXT")) {
    return [statement];
  }
  if (parsed.object.properties.length < 2) return [statement];
  const verb = `${parsed.op === "create" ? "CREATE" : "DROP"}${type === "FULLTEXT" ? " FULLTEXT" : ""}`;
  return parsed.object.properties.map((p) => `${verb} INDEX ${target(parsed.object, [p])}`);
}

/** A plain FalkorDB `CREATE INDEX FOR … ON (…)` (also Neo4j syntax), parsed. */
function createRange(statement: string): ParsedFalkorDBDdl | null {
  if (!isFalkorDBDdl(statement) || !/^\s*CREATE\s+INDEX\s/i.test(statement)) return null;
  const parsed = parseDdlStatement(statement);
  return parsed?.op === "create" ? { op: "create", object: parsed.object } : null;
}

/** FalkorDB's answers to a create of something that exists, or a drop of something that does not. */
const ALREADY = /already indexed|already exists/i;
const MISSING = /no such (index|constraint)|Index supports constraint/i;

/**
 * Run one DDL statement on FalkorDB with `IF [NOT] EXISTS` semantics (see the module comment):
 * composite range indexes property by property, "already indexed / exists" on create and "no
 * such index / constraint" (or an index a constraint still needs) on drop count as done. Any
 * other statement runs as is.
 */
export async function runFalkorDBDdl(
  run: (text: string) => Promise<unknown>,
  statement: string,
): Promise<void> {
  const ddl = isFalkorDBDdl(statement);
  for (const text of falkordbExecutable(statement)) {
    try {
      await run(text);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const create = /^\s*(CREATE|GRAPH\.CONSTRAINT\s+CREATE)\b/i.test(text);
      if (ddl && (create ? ALREADY : MISSING).test(message)) continue;
      throw e;
    }
  }
}

/**
 * `statements` (Cyphra's DDL in Neo4j syntax) for `dialect`, as {@link ddlForDialect} returns
 * them: translated with {@link falkordbDdl} for FalkorDB (other statements kept as they are).
 */
export function falkordbDdlStatements(statements: readonly string[]): string[] {
  return statements.map((s) => falkordbDdl(s)?.create ?? s);
}

/**
 * Drop every constraint and index of `client`'s graph (constraints first: an index a constraint
 * uses cannot be dropped before it), Cyphra's migration constraint included.
 */
export async function dropAllFalkorDBSchema(
  client: CyphraClient,
): Promise<{ constraints: number; indexes: number }> {
  const objects = await readFalkorDBSchemaObjects(client);
  const constraints = objects.filter((o) => o.kind === "constraint");
  const indexes = objects.filter((o) => o.kind === "index");
  await client.withSession(async (session) => {
    const run = (text: string) => session.run(text);
    for (const o of [...constraints, ...indexes]) {
      await runFalkorDBDdl(run, falkordbStatements(o).drop);
    }
  });
  const internal = (o: SchemaObject) => o.labelsOrTypes.includes(CYPHRA_MIGRATION_LABEL);
  return {
    constraints: constraints.filter((o) => !internal(o)).length,
    indexes: indexes.filter((o) => !internal(o)).length,
  };
}
