/**
 * Memgraph DDL: the constraints and indexes Cyphra creates, in Memgraph's syntax, and Memgraph's
 * schema objects read back for drift detection.
 *
 * Cyphra builds every statement in Neo4j's syntax first (`push.ts`, `diff.ts`); for the
 * `"memgraph"` dialect, {@link memgraphDdl} parses it ({@link parseDdlStatement}) and writes the
 * Memgraph equivalent, with the statement that drops it (Memgraph's constraints and property
 * indexes have no name: they are dropped by definition).
 *
 * | Neo4j                                                    | Memgraph                                             |
 * | -------------------------------------------------------- | ---------------------------------------------------- |
 * | `CREATE CONSTRAINT n IF NOT EXISTS FOR (n:L) REQUIRE (n.a, n.b) IS UNIQUE` | `CREATE CONSTRAINT ON (n:L) ASSERT n.a, n.b IS UNIQUE` |
 * | `CREATE RANGE INDEX … FOR (n:L) ON (n.a, n.b)`            | `CREATE INDEX ON :L(a, b)`                            |
 * | `CREATE RANGE INDEX … FOR ()-[r:T]-() ON (r.p)`           | `CREATE EDGE INDEX ON :T(p)`                          |
 * | `CREATE POINT INDEX … FOR (n:L) ON (n.p)`                 | `CREATE POINT INDEX ON :L(p)`                         |
 * | `CREATE VECTOR INDEX name … OPTIONS {indexConfig: …}`     | `CREATE VECTOR INDEX name ON :L(p) WITH CONFIG {…}`   |
 * | `CREATE FULLTEXT INDEX name … ON EACH [n.a, n.b]`         | `CREATE TEXT INDEX name ON :L(a, b)`                  |
 *
 * Memgraph's `CREATE` / `DROP` of constraints and property indexes are idempotent (no
 * `IF [NOT] EXISTS`), and run outside explicit transactions only. It has no relationship
 * constraints, no full-text analyzers and no vector quantization setting.
 *
 * @packageDocumentation
 */

import { UnsupportedFeatureError, type CyphraDialect } from "@cyphra/runtime";
import { parseDdlStatement, type SchemaObject } from "./drift.js";

/** Starting capacity of a Memgraph vector index (it grows as vectors are added). */
export const MEMGRAPH_VECTOR_CAPACITY = 1000;

function q(id: string): string {
  return "`" + id.replace(/`/g, "``") + "`";
}

function unsupported(feature: string, hint?: string): UnsupportedFeatureError {
  return new UnsupportedFeatureError(feature, "memgraph", hint);
}

function describe(o: SchemaObject): string {
  const props = o.properties.join(", ");
  return o.entityType === "NODE"
    ? `(:${o.labelsOrTypes.join("|")} {${props}})`
    : `()-[:${o.labelsOrTypes.join("|")} {${props}}]-()`;
}

/** Memgraph's vector metric for a Cyphra / Neo4j similarity function. */
export function memgraphVectorMetric(similarity: string): string {
  return similarity === "euclidean" ? "l2sq" : "cos";
}

/** The `CREATE` and `DROP` statements of a schema object on Memgraph (see the module table). */
export function memgraphStatements(o: SchemaObject): { create: string; drop: string } {
  // Objects Cyphra never creates, read back from the database (for `migrate reset`).
  if (o.type === "EDGE_PROPERTY") {
    const target = `ON :(${o.properties.map(q).join(", ")})`;
    return {
      create: `CREATE GLOBAL EDGE INDEX ${target}`,
      drop: `DROP GLOBAL EDGE INDEX ${target}`,
    };
  }
  if (o.labelsOrTypes.length !== 1) {
    throw unsupported(
      `A ${o.type.toLowerCase()} ${o.kind} on several labels ${describe(o)}`,
      "Memgraph indexes and constraints cover one label (or relationship type).",
    );
  }
  const label = q(o.labelsOrTypes[0]!);
  const props = o.properties.map(q);
  if (o.kind === "constraint") {
    if (o.entityType === "RELATIONSHIP") {
      throw unsupported(
        `A ${o.type === "UNIQUE" ? "uniqueness" : o.type.toLowerCase()} constraint on relationships ${describe(o)}`,
        "Memgraph has no relationship constraints. Remove @unique from the relationship property (or check it in your application).",
      );
    }
    let body: string;
    if (o.type === "UNIQUE") body = `${props.map((p) => `n.${p}`).join(", ")} IS UNIQUE`;
    else if (o.type === "EXISTS" && props.length === 1) body = `EXISTS (n.${props[0]})`;
    else if (o.type === "TYPE" && props.length === 1 && o.options.propertyType) {
      body = `n.${props[0]} IS TYPED ${String(o.options.propertyType)}`;
    } else throw unsupported(`A ${o.type} constraint ${describe(o)}`);
    const target = `ON (n:${label}) ASSERT ${body}`;
    return { create: `CREATE CONSTRAINT ${target}`, drop: `DROP CONSTRAINT ${target}` };
  }
  const name = o.name ?? "";
  switch (o.type) {
    case "LABEL":
      return { create: `CREATE INDEX ON :${label}`, drop: `DROP INDEX ON :${label}` };
    case "EDGE_TYPE":
      return { create: `CREATE EDGE INDEX ON :${label}`, drop: `DROP EDGE INDEX ON :${label}` };
    case "RANGE": {
      if (o.entityType === "RELATIONSHIP") {
        if (props.length !== 1) {
          throw unsupported(`A composite relationship index ${describe(o)}`);
        }
        const target = `ON :${label}(${props[0]})`;
        return { create: `CREATE EDGE INDEX ${target}`, drop: `DROP EDGE INDEX ${target}` };
      }
      const target = `ON :${label}(${props.join(", ")})`;
      return { create: `CREATE INDEX ${target}`, drop: `DROP INDEX ${target}` };
    }
    case "POINT": {
      if (o.entityType === "RELATIONSHIP") {
        throw unsupported(`A point index on relationships ${describe(o)}`);
      }
      const target = `ON :${label}(${props[0]})`;
      return { create: `CREATE POINT INDEX ${target}`, drop: `DROP POINT INDEX ${target}` };
    }
    case "VECTOR": {
      if (o.entityType === "RELATIONSHIP") {
        throw unsupported(`A vector index on relationships ${describe(o)}`);
      }
      const metric = memgraphVectorMetric(String(o.options.similarity ?? "cosine"));
      const config = `{"dimension": ${Number(o.options.dimensions)}, "capacity": ${MEMGRAPH_VECTOR_CAPACITY}, "metric": "${metric}"}`;
      return {
        create: `CREATE VECTOR INDEX ${q(name)} ON :${label}(${props[0]}) WITH CONFIG ${config}`,
        drop: `DROP VECTOR INDEX ${q(name)}`,
      };
    }
    case "FULLTEXT":
      if (o.entityType === "RELATIONSHIP") {
        throw unsupported(`A full-text index on relationships ${describe(o)}`);
      }
      return {
        create: `CREATE TEXT INDEX ${q(name)} ON :${label}(${props.join(", ")})`,
        drop: `DROP TEXT INDEX ${q(name)}`,
      };
    default:
      throw unsupported(`A ${o.type} index ${describe(o)}`);
  }
}

/**
 * The statement that drops a schema object read back from Memgraph: by name for text and vector
 * indexes (on nodes or relationships), by definition otherwise (see {@link memgraphStatements}).
 */
export function memgraphDropStatement(o: SchemaObject): string {
  if (o.kind === "index" && o.name !== null && (o.type === "VECTOR" || o.type === "FULLTEXT")) {
    return `DROP ${o.type === "VECTOR" ? "VECTOR" : "TEXT"} INDEX ${q(o.name)}`;
  }
  return memgraphStatements(o).drop;
}

/**
 * A Cyphra DDL statement in Neo4j syntax as Memgraph statements, or `null` for anything that is
 * not constraint / index creation (data statements, or a statement already in Memgraph's syntax).
 *
 * @throws {UnsupportedFeatureError} For DDL Memgraph has no equivalent of (relationship
 *   constraints, …).
 */
export function memgraphDdl(statement: string): { create: string; drop: string } | null {
  if (isMemgraphDdl(statement)) return null;
  const parsed = parseDdlStatement(statement);
  if (!parsed || parsed.op !== "create") return null;
  return memgraphStatements(parsed.object);
}

/** Whether `statement` is DDL in Memgraph's syntax (`… ON (n:L) ASSERT …`, `… ON :L(p)`). */
export function isMemgraphDdl(statement: string): boolean {
  return /^\s*(CREATE|DROP)\s+(?:(?:EDGE|POINT|TEXT|VECTOR(?: EDGE)?)\s+)?(CONSTRAINT|INDEX)\s+(?:\S+\s+)?ON\s+(\(|:)/i.test(
    statement,
  );
}

/**
 * `statements` (Cyphra's DDL in Neo4j syntax) for `dialect`: unchanged for Neo4j, translated
 * with {@link memgraphDdl} for Memgraph (other statements kept as they are).
 */
export function ddlForDialect(statements: readonly string[], dialect: CyphraDialect): string[] {
  if (dialect !== "memgraph") return [...statements];
  return statements.map((s) => memgraphDdl(s)?.create ?? s);
}

// ---------------------------------------------------------------------------
// Parsing Memgraph DDL (for drift detection on migrations written for Memgraph)
// ---------------------------------------------------------------------------

const ID = "(?:`(?:[^`]|``)+`|[A-Za-z_][A-Za-z0-9_]*)";

function unquote(id: string): string {
  return id.startsWith("`") ? id.slice(1, -1).replace(/``/g, "`") : id;
}

function splitIds(text: string): string[] {
  return (text.match(new RegExp(ID, "g")) ?? []).map(unquote);
}

/** Result of {@link parseMemgraphDdl}: the object a statement creates or drops. */
export type ParsedMemgraphDdl = {
  readonly op: "create" | "drop";
  readonly object: SchemaObject;
};

function nodeObject(
  kind: "constraint" | "index",
  type: string,
  label: string,
  properties: string[],
  name: string | null = null,
  options: Record<string, string | number | boolean> = {},
  entityType: "NODE" | "RELATIONSHIP" = "NODE",
): SchemaObject {
  return { name, kind, type, entityType, labelsOrTypes: [label], properties, options };
}

/**
 * Parse one Memgraph constraint / index statement (the forms {@link memgraphStatements} writes,
 * plus `ASSERT EXISTS`), or `null` when it is not Memgraph DDL. Uniqueness constraints list their
 * properties sorted (Memgraph reports them in no stable order). A `DROP TEXT|VECTOR INDEX name`
 * gives an object with only its name and type.
 */
export function parseMemgraphDdl(statement: string): ParsedMemgraphDdl | null {
  const text = statement.trim().replace(/;\s*$/, "").replace(/\s+/g, " ");
  const constraint = new RegExp(
    `^(CREATE|DROP) CONSTRAINT ON \\(\\s*(${ID})\\s*:\\s*(${ID})\\s*\\) ASSERT (.+)$`,
    "i",
  ).exec(text);
  if (constraint) {
    const op = constraint[1]!.toLowerCase() as "create" | "drop";
    const label = unquote(constraint[3]!);
    const body = constraint[4]!;
    const exists = /^EXISTS\s*\((.+)\)$/i.exec(body);
    if (exists) {
      const prop = splitIds(exists[1]!).at(-1)!;
      return { op, object: nodeObject("constraint", "EXISTS", label, [prop]) };
    }
    const unique = /^(.+) IS UNIQUE$/i.exec(body);
    if (!unique) return null;
    const props = unique[1]!
      .split(",")
      .map((p) => splitIds(p).at(-1)!)
      .sort();
    return { op, object: nodeObject("constraint", "UNIQUE", label, props) };
  }
  const named = new RegExp(
    `^(CREATE|DROP) (TEXT|VECTOR) INDEX (${ID})(?: ON :(${ID})\\((.*?)\\)(.*))?$`,
    "i",
  ).exec(text);
  if (named) {
    const op = named[1]!.toLowerCase() as "create" | "drop";
    const type = named[2]!.toUpperCase() === "TEXT" ? "FULLTEXT" : "VECTOR";
    const name = unquote(named[3]!);
    if (!named[4]) {
      return {
        op,
        object: {
          name,
          kind: "index",
          type,
          entityType: "NODE",
          labelsOrTypes: [],
          properties: [],
          options: {},
        },
      };
    }
    const options: Record<string, string | number> = {};
    if (type === "VECTOR") {
      const dims = /["'`]?dimension["'`]?\s*:\s*(\d+)/i.exec(named[6] ?? "")?.[1];
      if (dims) options.dimensions = Number(dims);
      const metric = /["'`]?metric["'`]?\s*:\s*["']([a-z0-9_]+)["']/i.exec(named[6] ?? "")?.[1];
      options.similarity = metric?.toLowerCase() === "l2sq" ? "euclidean" : "cosine";
    }
    return {
      op,
      object: nodeObject("index", type, unquote(named[4]), splitIds(named[5]!), name, options),
    };
  }
  const index = new RegExp(
    `^(CREATE|DROP) (?:(EDGE|POINT) )?INDEX ON :(${ID})\\((.*?)\\)$`,
    "i",
  ).exec(text);
  if (index) {
    const op = index[1]!.toLowerCase() as "create" | "drop";
    const kind = index[2]?.toUpperCase();
    return {
      op,
      object: nodeObject(
        "index",
        kind === "POINT" ? "POINT" : "RANGE",
        unquote(index[3]!),
        splitIds(index[4]!),
        null,
        {},
        kind === "EDGE" ? "RELATIONSHIP" : "NODE",
      ),
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Reading Memgraph's schema objects
// ---------------------------------------------------------------------------

type Row = Readonly<Record<string, unknown>>;

function list(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  return v === null || v === undefined ? [] : [String(v)];
}

function stripColon(label: unknown): string {
  const s = String(label ?? "");
  return s.startsWith(":") ? s.slice(1) : s;
}

/**
 * Normalize `SHOW CONSTRAINT INFO`, `SHOW INDEX INFO` and `SHOW VECTOR INDEX INFO` rows. Label
 * indexes, edge-type indexes and global edge-property indexes (which Cyphra never creates) are
 * kept with types `LABEL`, `EDGE_TYPE` and `EDGE_PROPERTY`, so drift reports them as extra.
 */
export function memgraphSchemaObjects(
  constraints: readonly Row[],
  indexes: readonly Row[],
  vectorIndexes: readonly Row[],
): SchemaObject[] {
  const out: SchemaObject[] = [];
  for (const c of constraints) {
    const t = String(c["constraint type"] ?? "").toLowerCase();
    const label = String(c.label);
    const props = list(c.properties);
    if (t === "unique") out.push(nodeObject("constraint", "UNIQUE", label, [...props].sort()));
    else if (t === "exists") out.push(nodeObject("constraint", "EXISTS", label, props));
    else {
      out.push(
        nodeObject("constraint", "TYPE", label, props, null, {
          propertyType: String(c.data_type ?? "").toUpperCase(),
        }),
      );
    }
  }
  const vectors = new Map(
    vectorIndexes.map((v) => [`${stripColon(v.label)}\u0000${String(v.property)}`, v]),
  );
  for (const i of indexes) {
    const t = String(i["index type"] ?? "");
    const label = stripColon(i.label);
    const props = list(i.property);
    if (t === "label+property") out.push(nodeObject("index", "RANGE", label, props));
    else if (t === "point") out.push(nodeObject("index", "POINT", label, props));
    else if (t === "edge-type+property") {
      out.push(nodeObject("index", "RANGE", label, props, null, {}, "RELATIONSHIP"));
    } else if (t.includes("_text")) {
      const name = /\(name: (.*)\)/.exec(t)?.[1] ?? null;
      const entity = t.startsWith("edge") ? "RELATIONSHIP" : "NODE";
      out.push(nodeObject("index", "FULLTEXT", label, props, name, {}, entity));
    } else if (t.endsWith("property_vector")) {
      const v = vectors.get(`${label}\u0000${props[0]}`);
      const entity = t.startsWith("edge") ? "RELATIONSHIP" : "NODE";
      out.push(
        nodeObject(
          "index",
          "VECTOR",
          label,
          props,
          v ? String(v.index_name) : null,
          {
            ...(v?.dimension !== undefined ? { dimensions: Number(v.dimension) } : {}),
            similarity: String(v?.metric ?? "cos") === "l2sq" ? "euclidean" : "cosine",
          },
          entity,
        ),
      );
    } else if (t === "label") out.push(nodeObject("index", "LABEL", label, []));
    else if (t === "edge-type") {
      out.push(nodeObject("index", "EDGE_TYPE", label, [], null, {}, "RELATIONSHIP"));
    } else if (t === "edge-property") {
      out.push(nodeObject("index", "EDGE_PROPERTY", "", props, null, {}, "RELATIONSHIP"));
    } else {
      out.push(nodeObject("index", t.toUpperCase(), label, props));
    }
  }
  return out;
}
