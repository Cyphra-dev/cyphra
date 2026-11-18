/**
 * Schema diffing: compare two {@link SchemaModel}s (the snapshot taken at the last migration and the
 * current schema) and plan the migration that takes a database from one to the other.
 *
 * Neo4j is schemaless, so the plan has two parts:
 * - **DDL**: uniqueness constraints and range indexes, named exactly like `cyphra push` names them.
 * - **Data steps**: backfills for new defaults, guards for newly required fields, and
 *   (commented-out) destructive cleanups for removed fields and models.
 *
 * @packageDocumentation
 */

import type {
  ResolvedNodeModel,
  ResolvedRelationshipModel,
  ResolvedScalarField,
  SchemaModel,
} from "@cyphra/schema";

function q(id: string): string {
  return "`" + id.replace(/`/g, "``") + "`";
}

function constraintName(name: string): string {
  return name.replace(/[^A-Za-z0-9_]/g, "_");
}

/** One named schema object (constraint or index) and the statement that creates it. */
export type DdlObject = {
  readonly name: string;
  readonly kind: "constraint" | "index";
  readonly create: string;
};

/**
 * Constraints and range indexes implied by a schema model. Names match
 * {@link import("./push.js").constraintStatementsFromSchema} so `push` and migrations interoperate.
 */
export function ddlObjectsFromModel(model: SchemaModel): DdlObject[] {
  const out: DdlObject[] = [];
  for (const n of model.nodes) {
    const scalars = n.fields.filter((f): f is ResolvedScalarField => f.kind === "scalar");
    for (const f of scalars) {
      const target = `FOR (n:${q(n.label)})`;
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
          create: `CREATE RANGE INDEX ${name} IF NOT EXISTS ${target} ON (n.${q(f.name)})`,
        });
      }
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
          create: `CREATE RANGE INDEX ${name} IF NOT EXISTS ${target} ON (r.${q(f.name)})`,
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
};

/** An empty schema, used as the "previous" side for a project's first migration. */
export const EMPTY_SCHEMA_MODEL: SchemaModel = { version: 1, nodes: [], relationships: [] };

function scalarsOf(n: ResolvedNodeModel): Map<string, ResolvedScalarField> {
  return new Map(
    n.fields.filter((f): f is ResolvedScalarField => f.kind === "scalar").map((f) => [f.name, f]),
  );
}

function typeLabel(f: ResolvedScalarField): string {
  return f.list ? `${f.type}[]` : f.optional ? `${f.type}?` : f.type;
}

/** Cypher expression that produces the default of `f`, plus params, or `null` if not expressible. */
function defaultExpression(
  f: ResolvedScalarField,
): { expr: string; params?: Record<string, unknown>; note?: string } | null {
  const d = f.default;
  if (!d) return null;
  if (d.kind === "literal") {
    if (f.type === "Int") return { expr: `toInteger($value)`, params: { value: d.value } };
    return { expr: "$value", params: { value: d.value } };
  }
  if (d.fn === "now") return { expr: f.type === "Date" ? "date()" : "datetime()" };
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

  if (before && before.type !== after.type) {
    warnings.push(
      `${model}.${name} changed type ${typeLabel(before)} → ${typeLabel(after)}; existing values are not converted. Add a conversion step (e.g. SET ${ref} = toInteger(${ref})) if needed.`,
    );
  }
  if (before && before.list !== after.list) {
    warnings.push(
      `${model}.${name} changed between list and single value; convert existing data manually.`,
    );
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
 */
export function diffSchemaModels(prev: SchemaModel, next: SchemaModel): MigrationPlan {
  // Order: drop obsolete DDL → fix up data (backfills, guards) → create new DDL, so that e.g. a
  // backfilled @id gets its values before the uniqueness constraint is created.
  const drops: MigrationStep[] = [];
  const creates: MigrationStep[] = [];
  const steps: MigrationStep[] = [];
  const warnings: string[] = [];

  // --- DDL -----------------------------------------------------------------
  const before = new Map(ddlObjectsFromModel(prev).map((o) => [o.name, o]));
  const after = new Map(ddlObjectsFromModel(next).map((o) => [o.name, o]));
  for (const [name, o] of before) {
    const n = after.get(name);
    if (!n || n.create !== o.create) {
      drops.push({
        kind: "statement",
        comment: `Drop ${o.kind} ${name}.`,
        cypher: `DROP ${o.kind === "constraint" ? "CONSTRAINT" : "INDEX"} ${name} IF EXISTS`,
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
    const ps = scalarsOf(p);
    const ns = scalarsOf(n);
    const removed = [...ps.keys()].filter((k) => !ns.has(k));
    const added = [...ns.keys()].filter((k) => !ps.has(k));
    for (const [name, f] of ns) {
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

  return { steps: [...drops, ...steps, ...creates], warnings };
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

/** `true` when the plan has nothing to do. */
export function isEmptyPlan(plan: MigrationPlan): boolean {
  return plan.steps.length === 0;
}
