/**
 * Schema diffing: compare two {@link SchemaModel}s (the snapshot taken at the last migration and the
 * current schema) and plan the migration that takes a database from one to the other.
 *
 * Neo4j is schemaless, so the plan has two parts:
 * - **DDL**: uniqueness constraints (single and composite) and range (single and composite),
 *   point, vector and full-text indexes, named exactly like
 *   `cyphra push` names them.
 * - **Data steps**: backfills for new defaults, guards for newly required fields, and
 *   (commented-out) destructive cleanups for removed fields and models.
 *
 * @packageDocumentation
 */

import type {
  ResolvedCompoundIndex,
  ResolvedCompoundUnique,
  ResolvedFulltextIndex,
  ResolvedNodeModel,
  ResolvedRelationField,
  ResolvedRelationshipModel,
  ResolvedScalarField,
  SchemaModel,
} from "@cyphra/schema";
import { formatRule } from "@cyphra/schema";
import type { CyphraDialect } from "@cyphra/runtime";
import { memgraphDdl } from "./memgraph.js";

function q(id: string): string {
  return "`" + id.replace(/`/g, "``") + "`";
}

function constraintName(name: string): string {
  return name.replace(/[^A-Za-z0-9_]/g, "_");
}

/**
 * `CREATE VECTOR INDEX … IF NOT EXISTS` for a `Vector(N) @vectorIndex(...)` field (Neo4j 5.15+).
 * Dimensions and similarity are part of the statement, so changing either one makes the diff drop
 * and recreate the index.
 */
export function vectorIndexStatement(label: string, f: ResolvedScalarField): string | null {
  if (f.type !== "Vector" || !f.vectorIndex || f.dimensions === undefined) return null;
  const entries = [
    `\`vector.dimensions\`: ${f.dimensions}`,
    `\`vector.similarity_function\`: '${f.vectorIndex.similarity}'`,
  ];
  if (f.vectorIndex.quantization !== undefined) {
    entries.push(`\`vector.quantization.enabled\`: ${f.vectorIndex.quantization}`);
  }
  const config = `{${entries.join(", ")}}`;
  return `CREATE VECTOR INDEX ${f.vectorIndex.name} IF NOT EXISTS FOR (n:${q(label)}) ON n.${q(f.name)} OPTIONS {indexConfig: ${config}}`;
}

/**
 * `CREATE FULLTEXT INDEX … IF NOT EXISTS` for a `@@fulltext([...])` model attribute. Fields,
 * analyzer and consistency are part of the statement, so changing any of them makes the diff drop
 * and recreate the index.
 */
export function fulltextIndexStatement(label: string, index: ResolvedFulltextIndex): string {
  const props = index.fields.map((f) => `n.${q(f)}`).join(", ");
  const entries: string[] = [];
  if (index.analyzer !== undefined) {
    entries.push(`\`fulltext.analyzer\`: '${index.analyzer}'`);
  }
  if (index.eventuallyConsistent !== undefined) {
    entries.push(`\`fulltext.eventually_consistent\`: ${index.eventuallyConsistent}`);
  }
  const options = entries.length ? ` OPTIONS {indexConfig: {${entries.join(", ")}}}` : "";
  return `CREATE FULLTEXT INDEX ${index.name} IF NOT EXISTS FOR (n:${q(label)}) ON EACH [${props}]${options}`;
}

/**
 * `CREATE CONSTRAINT … REQUIRE (n.a, n.b) IS UNIQUE` for a `@@unique([a, b])` model attribute: a
 * composite uniqueness constraint, available on Neo4j Community (a `NODE KEY`, which also requires
 * the properties to exist, is Enterprise-only and is not used).
 */
export function compoundUniqueStatement(label: string, c: ResolvedCompoundUnique): string {
  const props = c.fields.map((f) => `n.${q(f)}`).join(", ");
  return `CREATE CONSTRAINT ${c.name} IF NOT EXISTS FOR (n:${q(label)}) REQUIRE (${props}) IS UNIQUE`;
}

/** `CREATE RANGE INDEX … ON (n.a, n.b)` for a `@@index([a, b])` model attribute. */
export function compoundIndexStatement(label: string, i: ResolvedCompoundIndex): string {
  const props = i.fields.map((f) => `n.${q(f)}`).join(", ");
  return `CREATE RANGE INDEX ${i.name} IF NOT EXISTS FOR (n:${q(label)}) ON (${props})`;
}

/** `true` for the point types, whose `@index` is a `POINT` index (for distance and box queries). */
export function isPointType(type: string): boolean {
  return type === "Point" || type === "CartesianPoint";
}

/**
 * `CREATE RANGE INDEX …` for an `@index` field, or `CREATE POINT INDEX …` for a (single) point
 * field: a range index does not serve `point.distance` / `point.withinBBox`.
 */
export function propertyIndexStatement(
  name: string,
  target: string,
  ref: string,
  f: { readonly type: string; readonly list?: boolean },
): string {
  const kind = isPointType(f.type) && !f.list ? "POINT" : "RANGE";
  return `CREATE ${kind} INDEX ${name} IF NOT EXISTS ${target} ON (${ref})`;
}

/** One named schema object (constraint or index) and the statement that creates it. */
export type DdlObject = {
  /** Cyphra's name for it (the Neo4j name; Memgraph's constraints and property indexes have none). */
  readonly name: string;
  readonly kind: "constraint" | "index";
  readonly create: string;
  /**
   * The statement that drops it, when it cannot be dropped by name (Memgraph). Absent on Neo4j:
   * `DROP CONSTRAINT|INDEX <name> IF EXISTS`.
   */
  readonly drop?: string;
};

/** Options of {@link ddlObjectsFromModel} and {@link diffSchemaModels}. */
export type DdlOptions = {
  /** The DDL syntax to write (default `"neo4j"`). */
  readonly dialect?: CyphraDialect;
};

/**
 * Constraints and range indexes implied by a schema model. Names match
 * {@link import("./push.js").constraintStatementsFromSchema} so `push` and migrations interoperate.
 */
export function ddlObjectsFromModel(model: SchemaModel, options: DdlOptions = {}): DdlObject[] {
  const objects = neo4jDdlObjects(model);
  if (options.dialect !== "memgraph") return objects;
  return objects.map((o) => {
    const mg = memgraphDdl(o.create)!;
    return { ...o, create: mg.create, drop: mg.drop };
  });
}

function neo4jDdlObjects(model: SchemaModel): DdlObject[] {
  const out: DdlObject[] = [];
  // What a node inherits from an interface is indexed and constrained on the interface's label,
  // which covers every implementation: only the declaring model gets the DDL.
  const own = <T extends { readonly inheritedFrom?: string }>(xs: readonly T[] | undefined) =>
    (xs ?? []).filter((x) => !x.inheritedFrom);
  for (const n of model.nodes) {
    const scalars = own(n.fields).filter((f): f is ResolvedScalarField => f.kind === "scalar");
    for (const f of scalars) {
      const target = `FOR (n:${q(n.label)})`;
      const vector = vectorIndexStatement(n.label, f);
      if (vector) {
        out.push({ name: f.vectorIndex!.name, kind: "index", create: vector });
        continue;
      }
      if (f.id) {
        const name = constraintName(`${n.label}_${f.name}_id`);
        out.push({
          name,
          kind: "constraint",
          create: `CREATE CONSTRAINT ${name} IF NOT EXISTS ${target} REQUIRE n.${q(f.name)} IS UNIQUE`,
        });
      } else if (f.unique) {
        const name = constraintName(`${n.label}_${f.name}_unique`);
        out.push({
          name,
          kind: "constraint",
          create: `CREATE CONSTRAINT ${name} IF NOT EXISTS ${target} REQUIRE n.${q(f.name)} IS UNIQUE`,
        });
      } else if (f.index) {
        const name = constraintName(`${n.label}_${f.name}_idx`);
        out.push({
          name,
          kind: "index",
          create: propertyIndexStatement(name, target, `n.${q(f.name)}`, f),
        });
      }
    }
  }
  for (const n of model.nodes) {
    for (const c of own(n.compoundUniques)) {
      out.push({ name: c.name, kind: "constraint", create: compoundUniqueStatement(n.label, c) });
    }
    for (const i of n.compoundIndexes ?? []) {
      out.push({ name: i.name, kind: "index", create: compoundIndexStatement(n.label, i) });
    }
  }
  for (const n of model.nodes) {
    for (const index of own(n.fulltextIndexes)) {
      out.push({ name: index.name, kind: "index", create: fulltextIndexStatement(n.label, index) });
    }
  }
  for (const r of model.relationships) {
    const target = `FOR ()-[r:${q(r.relType)}]-()`;
    for (const f of r.properties) {
      if (f.unique) {
        const name = constraintName(`${r.name}_${f.name}_rel_unique`);
        out.push({
          name,
          kind: "constraint",
          create: `CREATE CONSTRAINT ${name} IF NOT EXISTS ${target} REQUIRE r.${q(f.name)} IS UNIQUE`,
        });
      } else if (f.index) {
        const name = constraintName(`${r.name}_${f.name}_rel_idx`);
        out.push({
          name,
          kind: "index",
          create: propertyIndexStatement(name, target, `r.${q(f.name)}`, f),
        });
      }
    }
  }
  return out;
}

/** A step of the planned migration. */
export type MigrationStep =
  | {
      /** Statement executed as-is. */
      readonly kind: "statement";
      readonly comment: string;
      readonly cypher: string;
      readonly params?: Readonly<Record<string, unknown>>;
    }
  | {
      /** Fails the migration if the query returns a non-zero `count`. */
      readonly kind: "guard";
      readonly comment: string;
      readonly countCypher: string;
      readonly message: string;
    }
  | {
      /** Destructive statement emitted commented-out: the author must opt in. */
      readonly kind: "destructive";
      readonly comment: string;
      readonly cypher: string;
    };

export type MigrationPlan = {
  readonly steps: readonly MigrationStep[];
  /** Things a human should review (type changes, likely renames, …). */
  readonly warnings: readonly string[];
  /**
   * Informational changes that need no migration step, such as `onDelete` rule changes (applied
   * by the client at delete time). Absent when there are none.
   */
  readonly notes?: readonly string[];
};

/** An empty schema, used as the "previous" side for a project's first migration. */
export const EMPTY_SCHEMA_MODEL: SchemaModel = { version: 1, nodes: [], relationships: [] };

function scalarsOf(n: ResolvedNodeModel): Map<string, ResolvedScalarField> {
  return new Map(
    n.fields.filter((f): f is ResolvedScalarField => f.kind === "scalar").map((f) => [f.name, f]),
  );
}

function typeLabel(f: ResolvedScalarField): string {
  if (f.type === "Vector") return `Vector(${f.dimensions})${f.optional ? "?" : ""}`;
  const name = f.type === "Enum" ? (f.enum ?? "Enum") : f.type;
  return f.list ? `${name}[]` : f.optional ? `${name}?` : name;
}

/**
 * Enum fields are stored as strings, so enum changes need no DDL. A value removed from a field's
 * enum may still be stored on existing nodes / edges, which then fail to read as that enum type:
 * warn, with a query that finds (and a hint to rewrite) them.
 */
function enumValueWarnings(
  owner: string,
  match: string,
  ref: string,
  before: ResolvedScalarField,
  after: ResolvedScalarField,
  warnings: string[],
): void {
  if (before.type !== "Enum" || after.type !== "Enum" || before.list !== after.list) return;
  const kept = new Set(after.enumValues ?? []);
  const removed = (before.enumValues ?? []).filter((v) => !kept.has(v));
  if (removed.length === 0) return;
  const values = `[${removed.map((v) => `'${v}'`).join(", ")}]`;
  const find = before.list
    ? `${match} WHERE any(v IN ${ref} WHERE v IN ${values})`
    : `${match} WHERE ${ref} IN ${values}`;
  const rewrite = before.list
    ? `SET ${ref} = [v IN ${ref} WHERE NOT v IN ${values}]`
    : `SET ${ref} = '${after.enumValues?.[0] ?? ""}'`;
  warnings.push(
    `${owner} no longer accepts ${removed.join(", ")} (removed from enum ${after.enum}); existing values are not migrated. Find them with \`${find} RETURN count(*)\` and rewrite them in this migration (e.g. ${rewrite}).`,
  );
}

/** Cypher function that builds a value of each temporal type (from ISO text, or `now` without arguments). */
const TEMPORAL_FUNCTIONS: Partial<Record<string, string>> = {
  DateTime: "datetime",
  Date: "date",
  LocalDateTime: "localdatetime",
  LocalTime: "localtime",
  Time: "time",
  Duration: "duration",
};

/** Cypher expression that produces the default of `f`, plus params, or `null` if not expressible. */
function defaultExpression(
  f: ResolvedScalarField,
): { expr: string; params?: Record<string, unknown>; note?: string } | null {
  const d = f.default;
  if (!d) return null;
  if (d.kind === "literal") {
    // A BigInt default is its decimal digits: toInteger() keeps all 64 bits.
    if (f.type === "Int" || f.type === "BigInt") {
      return { expr: `toInteger($value)`, params: { value: d.value } };
    }
    // Temporal defaults are ISO 8601 text: parse it in Cypher so the property is a temporal value.
    const temporal = TEMPORAL_FUNCTIONS[f.type];
    if (temporal) return { expr: `${temporal}($value)`, params: { value: d.value } };
    return { expr: "$value", params: { value: d.value } };
  }
  if (d.fn === "now") return { expr: `${TEMPORAL_FUNCTIONS[f.type] ?? "datetime"}()` };
  if (d.fn === "uuid") return { expr: "randomUUID()" };
  return {
    expr: "randomUUID()",
    note: "cuid() cannot be generated in Cypher; existing nodes get a UUID instead",
  };
}

function nodeDataSteps(
  label: string,
  model: string,
  name: string,
  before: ResolvedScalarField | undefined,
  after: ResolvedScalarField,
  steps: MigrationStep[],
  warnings: string[],
): void {
  const ref = `n.${q(name)}`;
  const match = `MATCH (n:${q(label)}) WHERE ${ref} IS NULL`;
  const nowRequired = !after.optional && !after.list;
  const wasRequired = before ? !before.optional && !before.list : false;

  if (before && after.type === "Vector" && before.type === "Vector") {
    if (before.dimensions !== after.dimensions) {
      warnings.push(
        `${model}.${name} changed dimensions ${before.dimensions} → ${after.dimensions}; existing embeddings keep their old length and are not indexed (or returned by findSimilar) until re-embedded.`,
      );
    }
  } else if (before && (before.type !== after.type || before.enum !== after.enum)) {
    warnings.push(
      `${model}.${name} changed type ${typeLabel(before)} → ${typeLabel(after)}; existing values are not converted. Add a conversion step (e.g. SET ${ref} = toInteger(${ref})) if needed.`,
    );
  }
  if (before && before.list !== after.list) {
    warnings.push(
      `${model}.${name} changed between list and single value; convert existing data manually.`,
    );
  }
  if (before && before.enum === after.enum) {
    enumValueWarnings(`${model}.${name}`, `MATCH (n:${q(label)})`, ref, before, after, warnings);
  }

  const def = defaultExpression(after);
  if (def && (!before || (nowRequired && !wasRequired))) {
    steps.push({
      kind: "statement",
      comment: `Backfill ${model}.${name} with its default on existing nodes${def.note ? ` (${def.note})` : ""}.`,
      cypher: `${match} SET ${ref} = ${def.expr}`,
      ...(def.params ? { params: def.params } : {}),
    });
    return;
  }
  if (nowRequired && !wasRequired) {
    steps.push({
      kind: "guard",
      comment: `${model}.${name} is now required and has no default: make sure no existing node lacks it.`,
      countCypher: `${match} RETURN count(n) AS count`,
      message: `${model}.${name} is required but some existing ${label} nodes do not have it. Backfill them in this migration before the guard (or add a @default).`,
    });
  }
}

/**
 * Plan the migration from `prev` to `next`.
 *
 * @param prev - Schema at the last migration ({@link EMPTY_SCHEMA_MODEL} for the first one).
 * @param next - Current schema.
 * @param options - `dialect: "memgraph"` writes Memgraph DDL (constraints and property indexes
 *   dropped by definition, not by name).
 */
export function diffSchemaModels(
  prev: SchemaModel,
  next: SchemaModel,
  options: DdlOptions = {},
): MigrationPlan {
  // Order: drop obsolete DDL → fix up data (backfills, guards) → create new DDL, so that e.g. a
  // backfilled @id gets its values before the uniqueness constraint is created.
  const drops: MigrationStep[] = [];
  const creates: MigrationStep[] = [];
  const steps: MigrationStep[] = [];
  const warnings: string[] = [];

  // --- DDL -----------------------------------------------------------------
  const before = new Map(ddlObjectsFromModel(prev, options).map((o) => [o.name, o]));
  const after = new Map(ddlObjectsFromModel(next, options).map((o) => [o.name, o]));
  for (const [name, o] of before) {
    const n = after.get(name);
    if (!n || n.create !== o.create) {
      drops.push({
        kind: "statement",
        comment: `Drop ${o.kind} ${name}.`,
        cypher:
          o.drop ?? `DROP ${o.kind === "constraint" ? "CONSTRAINT" : "INDEX"} ${name} IF EXISTS`,
      });
    }
  }
  for (const [name, o] of after) {
    const p = before.get(name);
    if (!p || p.create !== o.create) {
      creates.push({ kind: "statement", comment: `Create ${o.kind} ${name}.`, cypher: o.create });
    }
  }

  // --- Node data -----------------------------------------------------------
  const prevNodes = new Map(prev.nodes.map((n) => [n.name, n]));
  const nextNodes = new Map(next.nodes.map((n) => [n.name, n]));

  const removedNodes = prev.nodes.filter((n) => !nextNodes.has(n.name));
  const addedNodes = next.nodes.filter((n) => !prevNodes.has(n.name));
  for (const r of removedNodes) {
    // An interface's nodes are its implementations' nodes: losing the interface only drops the
    // label (see labelSteps), never the nodes.
    if (r.abstract) continue;
    steps.push({
      kind: "destructive",
      comment: `Model ${r.name} was removed. Uncomment to delete its nodes (or rename the label instead: db.migrate.renameLabel).`,
      cypher: `MATCH (n:${q(r.label)}) DETACH DELETE n`,
    });
  }
  if (removedNodes.length && addedNodes.length) {
    warnings.push(
      `Models removed (${removedNodes.map((n) => n.name).join(", ")}) and added (${addedNodes.map((n) => n.name).join(", ")}): if this is a rename, replace the generated steps with db.migrate.renameLabel({ from, to }).`,
    );
  }

  for (const n of next.nodes) {
    const p = prevNodes.get(n.name);
    if (!p) continue; // new model: no existing nodes to fix up
    labelSteps(p, n, prevNodes, nextNodes, steps);
    const ps = scalarsOf(p);
    const ns = scalarsOf(n);
    // A field inherited from an interface the node already implemented is migrated on the
    // interface's label, which its nodes carry: no second step on the node's own label.
    const viaInterface = (f: ResolvedScalarField | undefined) =>
      Boolean(
        f?.inheritedFrom &&
        (p.interfaces ?? []).includes(f.inheritedFrom) &&
        (n.interfaces ?? []).includes(f.inheritedFrom),
      );
    // An interface's nodes are its implementations': what it inherits from the interfaces it
    // extends is migrated on each implementation (gained ancestors) or on the declaring label.
    const skip = (f: ResolvedScalarField | undefined) =>
      n.abstract ? Boolean(f?.inheritedFrom) : viaInterface(f);
    const removed = [...ps.keys()].filter((k) => !ns.has(k) && !skip(ps.get(k)));
    const added = [...ns.keys()].filter((k) => !ps.has(k) && !skip(ns.get(k)));
    for (const [name, f] of ns) {
      if (n.abstract && f.inheritedFrom) continue;
      if (viaInterface(f) && (!ps.has(name) || viaInterface(ps.get(name)))) continue;
      nodeDataSteps(n.label, n.name, name, ps.get(name), f, steps, warnings);
    }
    for (const name of removed) {
      steps.push({
        kind: "destructive",
        comment: `${n.name}.${name} was removed. Uncomment to delete the property from existing nodes.`,
        cypher: `MATCH (n:${q(n.label)}) WHERE n.${q(name)} IS NOT NULL REMOVE n.${q(name)}`,
      });
    }
    if (removed.length && added.length) {
      warnings.push(
        `${n.name}: fields removed (${removed.join(", ")}) and added (${added.join(", ")}). If this is a rename, use db.migrate.renameProperty({ label: ${JSON.stringify(n.label)}, from, to }) instead of the generated steps.`,
      );
    }
  }

  // --- Relationship models ---------------------------------------------------
  const prevRels = new Map(prev.relationships.map((r) => [r.name, r]));
  for (const r of next.relationships) {
    const p = prevRels.get(r.name);
    if (!p) continue;
    relationshipDataSteps(p, r, steps, warnings);
  }

  const notes = [...onDeleteNotes(prev, next), ...ruleNotes(prev, next)];
  return { steps: [...drops, ...steps, ...creates], warnings, ...(notes.length ? { notes } : {}) };
}

/**
 * Validation-rule changes (`@length`, `@min`, …) on scalar fields present on both sides: no DDL,
 * and existing values are not re-checked (the client checks the values it writes).
 */
function ruleNotes(prev: SchemaModel, next: SchemaModel): string[] {
  const notes: string[] = [];
  const text = (f: ResolvedScalarField | undefined) =>
    f?.rules?.length ? f.rules.map(formatRule).join(" ") : "none";
  const scalarsOf = (fields: readonly (ResolvedScalarField | ResolvedRelationField)[]) =>
    new Map(
      fields.filter((f): f is ResolvedScalarField => f.kind === "scalar").map((f) => [f.name, f]),
    );
  const models = (m: SchemaModel) =>
    new Map([
      ...m.nodes.map((n) => [n.name, scalarsOf(n.fields)] as const),
      ...m.relationships.map((r) => [r.name, scalarsOf(r.properties)] as const),
    ]);
  const before = models(prev);
  for (const [name, fields] of models(next)) {
    const old = before.get(name);
    if (!old) continue;
    for (const [field, f] of fields) {
      const o = old.get(field);
      if (!o) continue;
      const a = text(o);
      const b = text(f);
      if (a !== b) {
        notes.push(
          `${name}.${field}: validation rules ${a} → ${b} (no migration step: the client checks the values it writes; existing values are not re-checked).`,
        );
      }
    }
  }
  return notes;
}

/** `onDelete` rule changes on relation fields present on both sides (no DDL: the client applies them). */
function onDeleteNotes(prev: SchemaModel, next: SchemaModel): string[] {
  const notes: string[] = [];
  const relationsOf = (n: ResolvedNodeModel) =>
    new Map(
      n.fields
        .filter((f): f is ResolvedRelationField => f.kind === "relation")
        .map((f) => [f.name, f]),
    );
  const prevNodes = new Map(prev.nodes.map((n) => [n.name, n]));
  for (const n of next.nodes) {
    const p = prevNodes.get(n.name);
    if (!p) continue;
    const before = relationsOf(p);
    for (const [name, f] of relationsOf(n)) {
      const old = before.get(name);
      if (!old) continue;
      const a = old.onDelete ?? "SetNull";
      const b = f.onDelete ?? "SetNull";
      if (a !== b) {
        notes.push(
          `${n.name}.${name}: onDelete ${a} → ${b} (no migration step: the client applies onDelete rules when it deletes).`,
        );
      }
    }
  }
  return notes;
}

function relationshipDataSteps(
  prev: ResolvedRelationshipModel,
  next: ResolvedRelationshipModel,
  steps: MigrationStep[],
  warnings: string[],
): void {
  if (prev.relType !== next.relType) {
    warnings.push(
      `Relationship ${next.name} changed type :${prev.relType} → :${next.relType}; existing edges are not retyped.`,
    );
    return;
  }
  const ps = new Map(prev.properties.map((f) => [f.name, f]));
  for (const f of next.properties) {
    const p = ps.get(f.name);
    if (p && p.enum === f.enum) {
      const ref = `r.${q(f.name)}`;
      enumValueWarnings(
        `${next.name}.${f.name}`,
        `MATCH ()-[r:${q(next.relType)}]->()`,
        ref,
        p,
        f,
        warnings,
      );
    }
    const def = defaultExpression(f);
    const nowRequired = !f.optional && !f.list;
    const wasRequired = p ? !p.optional && !p.list : false;
    if (def && (!p || (nowRequired && !wasRequired))) {
      steps.push({
        kind: "statement",
        comment: `Backfill ${next.name}.${f.name} with its default on existing edges${def.note ? ` (${def.note})` : ""}.`,
        cypher: `MATCH ()-[r:${q(next.relType)}]->() WHERE r.${q(f.name)} IS NULL SET r.${q(f.name)} = ${def.expr}`,
        ...(def.params ? { params: def.params } : {}),
      });
    } else if (nowRequired && !wasRequired) {
      warnings.push(
        `${next.name}.${f.name} is now required without a default; existing :${next.relType} edges may lack it.`,
      );
    }
  }
}

/**
 * A node that starts implementing an interface (directly, or through an interface extending it)
 * gets its label on existing nodes (before the interface's constraints are created, so they
 * validate every implementation); one that stops implementing it loses the label. Labels come
 * from each side's own model (`label`).
 */
function labelSteps(
  prev: ResolvedNodeModel,
  next: ResolvedNodeModel,
  prevNodes: ReadonlyMap<string, ResolvedNodeModel>,
  nextNodes: ReadonlyMap<string, ResolvedNodeModel>,
  steps: MigrationStep[],
): void {
  // An interface's `interfaces` are the ones it extends, but its nodes are its implementations',
  // whose own (transitive) `interfaces` already list every label they gain or lose.
  if (prev.abstract || next.abstract) return;
  const labelOf = (nodes: ReadonlyMap<string, ResolvedNodeModel>, name: string) =>
    nodes.get(name)?.label ?? name;
  const before = new Set((prev.interfaces ?? []).map((i) => labelOf(prevNodes, i)));
  const after = new Set((next.interfaces ?? []).map((i) => labelOf(nextNodes, i)));
  const match = `MATCH (n:${q(prev.label)})`;
  for (const label of after) {
    if (before.has(label)) continue;
    steps.push({
      kind: "statement",
      comment: `${next.name} now implements ${label}: add the :${label} label to existing ${prev.label} nodes.`,
      cypher: `${match} WHERE NOT n:${q(label)} SET n:${q(label)}`,
    });
  }
  for (const label of before) {
    if (after.has(label)) continue;
    steps.push({
      kind: "statement",
      comment: `${next.name} no longer implements ${label}: remove the :${label} label from existing ${prev.label} nodes.`,
      cypher: `${match} WHERE n:${q(label)} REMOVE n:${q(label)}`,
    });
  }
}

/** `true` when the plan has nothing to do. */
export function isEmptyPlan(plan: MigrationPlan): boolean {
  return plan.steps.length === 0;
}
