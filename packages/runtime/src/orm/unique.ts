/**
 * Map Neo4j's uniqueness violations (`Neo.ClientError.Schema.ConstraintValidationFailed` with
 * "… already exists with label …") to {@link UniqueConstraintError}, on both transports.
 */
import type { SchemaModel } from "@cyphra/schema";
import { UniqueConstraintError } from "./errors.js";

/** Neo4j's status code for a write that breaks a schema constraint. */
export const CONSTRAINT_VALIDATION_FAILED = "Neo.ClientError.Schema.ConstraintValidationFailed";

/** What Neo4j's message says about the duplicate. */
export type ParsedUniqueViolation = {
  /** `node` for a label constraint, `relationship` for a relationship-type constraint. */
  readonly entity: "node" | "relationship";
  /** Label (node) or relationship type, unescaped. */
  readonly label: string;
  /**
   * Property names, in the message's order. A string value that itself contains "`x` = " can add
   * spurious names: {@link uniqueConstraintError} keeps only the ones the schema's constraints have.
   */
  readonly properties: readonly string[];
};

/** A backtick-quoted identifier (a doubled backtick escapes one). */
const QUOTED = "`((?:[^`]|``)+)`";
const HEAD = new RegExp(
  `already exists with (label|type) ${QUOTED} and propert(?:y|ies) (${QUOTED} = [\\s\\S]*)$`,
);
const PROPERTY = new RegExp(`(?:^|, )${QUOTED} = `, "g");
/**
 * Memgraph (3.x), at commit: `Unable to commit due to unique constraint violation on :User(email)`
 * or `… on :Member(email, tenantId)` (properties sorted, no values). Memgraph has no relationship
 * constraints.
 */
const MEMGRAPH_HEAD = /unique constraint violation on :([^(]+)\((.*)\)\s*$/;

function unquote(s: string): string {
  return s.replace(/``/g, "`");
}

/**
 * Read the label and properties from a uniqueness violation message, e.g.
 * ``Node(12) already exists with label `User` and property `email` = 'a@example.com'`` or
 * ``… with label `Member` and properties `tenantId` = 't1', `email` = 'a@example.com'`` (Neo4j 4,
 * 5 and 2025, Bolt and Query API; the node id may be an element id), or Memgraph's
 * ``Unable to commit due to unique constraint violation on :User(email)``.
 */
export function parseUniqueViolation(message: string): ParsedUniqueViolation | undefined {
  const mg = MEMGRAPH_HEAD.exec(message);
  if (mg) {
    return {
      entity: "node",
      label: mg[1]!,
      properties: mg[2]!
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean),
    };
  }
  const m = HEAD.exec(message);
  if (!m) return undefined;
  const properties: string[] = [];
  for (const p of m[3]!.matchAll(PROPERTY)) properties.push(unquote(p[1]!));
  return {
    entity: m[1] === "type" ? "relationship" : "node",
    label: unquote(m[2]!),
    properties,
  };
}

type ErrorLike = { code?: unknown; gqlStatus?: unknown; message?: unknown; cause?: unknown };

/** Messages Neo4j uses for a uniqueness conflict (a plain write, or a `MERGE` that cannot create). */
const UNIQUE_MESSAGE = /already exists with (?:label|type) `|conflicts? with existing unique/;

/** Memgraph reports every error with this one code (the message tells them apart). */
const MEMGRAPH_ERROR_CODE = /^Memgraph\./;

/**
 * GQL statuses of a uniqueness violation (Neo4j 2025+): `22N79` property uniqueness constraint
 * violated, `22N80` index entry conflict (its cause). Neo4j 5 reports `50N42` (general).
 */
const UNIQUE_GQL_STATUSES = new Set(["22N79", "22N80"]);

function asErrorLike(e: unknown): ErrorLike | undefined {
  return e !== null && typeof e === "object" ? (e as ErrorLike) : undefined;
}

/**
 * The Neo4j error of a uniqueness violation (`err` or, for a wrapped driver-6 / GQL error, one of
 * its causes), or `undefined` for any other error. Other `ConstraintValidationFailed` errors
 * (deleting a node that still has relationships, a missing required property) are not matched.
 */
function uniqueViolation(err: unknown): ErrorLike | undefined {
  let e = asErrorLike(err);
  for (let depth = 0; e && depth < 5; depth++) {
    const message = typeof e.message === "string" ? e.message : "";
    if (
      (e.code === CONSTRAINT_VALIDATION_FAILED && UNIQUE_MESSAGE.test(message)) ||
      (typeof e.code === "string" &&
        MEMGRAPH_ERROR_CODE.test(e.code) &&
        MEMGRAPH_HEAD.test(message)) ||
      (typeof e.gqlStatus === "string" && UNIQUE_GQL_STATUSES.has(e.gqlStatus))
    ) {
      return e;
    }
    e = asErrorLike(e.cause);
  }
  return undefined;
}

/** Constraint names, as `@cyphra/migrator` builds them. */
function constraintName(name: string): string {
  return name.replace(/[^A-Za-z0-9_]/g, "_");
}

type Candidate = { model: string; fields: readonly string[]; constraint: string };

/** Uniqueness constraints the schema declares on `label` (node) or `type` (relationship). */
function candidates(schema: SchemaModel, parsed: ParsedUniqueViolation): Candidate[] {
  const out: Candidate[] = [];
  if (parsed.entity === "node") {
    const node = schema.nodes.find((n) => n.label === parsed.label);
    if (!node) return out;
    for (const f of node.fields) {
      // Inherited fields are constrained on the interface's label, not this one.
      if (f.kind !== "scalar" || f.inheritedFrom || !(f.id || f.unique)) continue;
      const suffix = f.id ? "id" : "unique";
      out.push({
        model: node.name,
        fields: [f.name],
        constraint: constraintName(`${node.label}_${f.name}_${suffix}`),
      });
    }
    for (const c of node.compoundUniques ?? []) {
      if (c.inheritedFrom) continue;
      out.push({ model: node.name, fields: c.fields, constraint: c.name });
    }
    return out;
  }
  for (const r of schema.relationships) {
    if (r.relType !== parsed.label) continue;
    for (const f of r.properties) {
      if (!f.unique) continue;
      out.push({
        model: r.name,
        fields: [f.name],
        constraint: constraintName(`${r.name}_${f.name}_rel_unique`),
      });
    }
  }
  return out;
}

function modelOf(schema: SchemaModel, parsed: ParsedUniqueViolation): string | undefined {
  if (parsed.entity === "node") return schema.nodes.find((n) => n.label === parsed.label)?.name;
  const rels = schema.relationships.filter((r) => r.relType === parsed.label);
  return rels.length === 1 ? rels[0]!.name : undefined;
}

/**
 * `err` as a {@link UniqueConstraintError} when it is a Neo4j uniqueness violation, else
 * `undefined`. The model, fields and constraint name come from Neo4j's message and the schema;
 * what cannot be read is left `undefined` / `[]`.
 */
export function uniqueConstraintError(
  schema: SchemaModel,
  err: unknown,
): UniqueConstraintError | undefined {
  if (err instanceof UniqueConstraintError) return err;
  const violation = uniqueViolation(err);
  if (!violation) return undefined;
  const code = typeof violation.code === "string" ? violation.code : CONSTRAINT_VALIDATION_FAILED;
  const gqlStatus = typeof violation.gqlStatus === "string" ? violation.gqlStatus : undefined;
  // A GQL status alone identifies the violation: the server may send no message at all.
  const message = typeof violation.message === "string" ? violation.message.trim() : "";
  const parsed = parseUniqueViolation(message);
  if (!parsed) {
    return new UniqueConstraintError(
      message
        ? `Unique constraint failed: ${message}`
        : `Unique constraint failed${gqlStatus ? ` (GQL status ${gqlStatus})` : ""}: a node or relationship with the same value already exists.`,
      { code, gqlStatus },
      { cause: err },
    );
  }
  const props = new Set(parsed.properties);
  // The constraint whose fields are all in the message (the largest one, when string values
  // quoting "`x` = " add spurious names); a single property names a single-field constraint.
  const match = candidates(schema, parsed)
    .filter((c) => c.fields.every((f) => props.has(f)))
    .filter((c) => parsed.properties.length > 1 || c.fields.length === 1)
    .sort((a, b) => b.fields.length - a.fields.length)[0];
  const model = match?.model ?? modelOf(schema, parsed);
  const fields = match?.fields ?? parsed.properties;
  const subject = `${model ?? parsed.label}${fields.length ? `(${fields.join(", ")})` : ""}`;
  return new UniqueConstraintError(
    `Unique constraint failed on ${subject}${match ? ` (constraint ${match.constraint})` : ""}: a ${parsed.entity === "node" ? "node" : "relationship"} with the same value${fields.length > 1 ? "s" : ""} already exists.`,
    { model, fields: [...fields], constraint: match?.constraint, code, gqlStatus },
    { cause: err },
  );
}

/** `err` mapped by {@link uniqueConstraintError}, or `err` itself. */
export function mapUniqueError(schema: SchemaModel, err: unknown): unknown {
  return uniqueConstraintError(schema, err) ?? err;
}
