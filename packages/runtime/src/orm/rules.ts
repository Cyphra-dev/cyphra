/**
 * Validation rules of the schema (`@length`, `@min`, `@email`, …) on writes.
 *
 * {@link validateWriteArgs} walks the arguments of a write (scalar data, nested `create` /
 * `connect` / `set` / `update` / `upsert` / `connectOrCreate` items and their `$edge` properties)
 * before any statement runs, collects every value that breaks a rule and throws one
 * {@link CyphraValidationError} listing them. Numeric update operators (`increment`, `decrement`,
 * `multiply`) on a field with `@min` / `@max` are checked in Cypher against the resulting value:
 * see {@link numericGuard}.
 *
 * @packageDocumentation
 */

import {
  checkRules,
  listRequiresElements,
  type ResolvedNodeModel,
  type ResolvedScalarField,
  type SchemaModel,
} from "@cyphra/schema";
import { CyphraValidationError, type ValidationIssue } from "./errors.js";

type AnyRecord = Record<string, unknown>;
type Path = readonly (string | number)[];

/** `create`: absent lists count as `[]`; `update`: only the values given are checked. */
type Mode = "create" | "update";

function isPlainObject(v: unknown): v is AnyRecord {
  return typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Date);
}

/** `data.posts.create[0].title` */
export function formatPath(path: Path): string {
  let out = "";
  for (const p of path) {
    if (typeof p === "number") out += `[${p}]`;
    else out += out ? `.${p}` : p;
  }
  return out;
}

/** The error for `issues` (at least one). */
export function rulesError(op: string, issues: readonly ValidationIssue[]): CyphraValidationError {
  const lines = issues.map(
    (i) => `  - ${formatPath(i.path)} (${i.model}.${i.field}): ${i.message}`,
  );
  return new CyphraValidationError(
    `${op}: ${issues.length} value${issues.length === 1 ? "" : "s"} break${issues.length === 1 ? "s" : ""} the schema's validation rules:\n${lines.join("\n")}`,
    issues,
  );
}

class Collector {
  readonly issues: ValidationIssue[] = [];

  constructor(private readonly schema: SchemaModel) {}

  scalars(
    owner: string,
    fields: readonly ResolvedScalarField[],
    data: AnyRecord,
    path: Path,
    mode: Mode,
    skip: readonly string[] = [],
  ): void {
    for (const f of fields) {
      if (!f.rules?.length || skip.includes(f.name)) continue;
      let v = data[f.name];
      if (v === undefined && mode === "update") continue;
      if (v === undefined || v === null) {
        if (!listRequiresElements(f)) continue;
        v = [];
      }
      // `{ increment: 1 }` and other operators: checked in Cypher (see `numericGuard`).
      if (isPlainObject(v) && (f.type === "Int" || f.type === "Float" || f.type === "BigInt")) {
        continue;
      }
      for (const broken of checkRules(f, v)) {
        this.issues.push({
          path: [...path, f.name],
          model: owner,
          field: f.name,
          rule: broken.rule,
          message: broken.message,
        });
      }
    }
  }

  node(model: ResolvedNodeModel, data: unknown, path: Path, mode: Mode, skip?: readonly string[]) {
    if (!isPlainObject(data)) return;
    const scalars = model.fields.filter((f): f is ResolvedScalarField => f.kind === "scalar");
    this.scalars(model.name, scalars, data, path, mode, skip);
    for (const rel of model.fields) {
      if (rel.kind !== "relation") continue;
      const spec = data[rel.name];
      if (!isPlainObject(spec)) continue;
      const target = this.schema.nodes.find((n) => n.name === rel.target);
      const edge = rel.edge
        ? this.schema.relationships.find((r) => r.name === rel.edge)
        : undefined;
      const items = (op: string, each: (item: AnyRecord, at: Path) => void) => {
        const v = spec[op];
        if (v === undefined) return;
        const at = [...path, rel.name, op];
        if (Array.isArray(v)) v.forEach((x, i) => isPlainObject(x) && each(x, [...at, i]));
        else if (isPlainObject(v)) each(v, at);
      };
      const edgeProps = ($edge: unknown, at: Path, edgeMode: Mode) => {
        if (!edge) return;
        // A new edge without `$edge` still gets created: check its absent lists.
        const props = isPlainObject($edge) ? $edge : $edge === undefined ? {} : undefined;
        if (props) this.scalars(edge.name, edge.properties, props, [...at, "$edge"], edgeMode);
      };
      items("create", (item, at) => {
        const { $edge, ...rest } = item;
        if (target?.union) {
          // `{ Post: { … } }`: the data of the member it names (the engine rejects other shapes).
          const [member, data] = Object.entries(rest).find(([, v]) => v !== undefined) ?? [];
          const m = this.schema.nodes.find((n) => n.name === member);
          if (m && (target.implementations ?? []).includes(m.name)) {
            this.node(m, data, [...at, m.name], "create");
          }
        } else if (target) this.node(target, rest, at, "create");
        edgeProps($edge, at, "create");
      });
      // An existing edge only gets the `$edge` values given.
      for (const op of ["connect", "set"]) {
        items(op, (item, at) => {
          if (item.$edge !== undefined) edgeProps(item.$edge, at, "update");
        });
      }
      if (!target || target.union) continue;
      // Nested update: `{ where, data }` on a to-many relation, the data itself on a to-one.
      items("update", (item, at) => {
        if (rel.many) this.node(target, item.data, [...at, "data"], "update");
        else this.node(target, item, at, "update");
      });
      // Nested upsert and connectOrCreate: the node they may create, with its new edge.
      items("upsert", (item, at) => {
        this.node(target, item.create, [...at, "create"], "create");
        this.node(target, item.update, [...at, "update"], "update");
        edgeProps(item.$edge, at, "create");
      });
      items("connectOrCreate", (item, at) => {
        this.node(target, item.create, [...at, "create"], "create");
        if (item.$edge !== undefined) edgeProps(item.$edge, at, "update");
      });
    }
  }
}

/**
 * Check the validation rules of every value a write sets, before anything runs.
 *
 * @param op - `create`, `createMany`, `update`, `updateMany` or `upsert`.
 * @param args - The operation's arguments; issue paths start from them (`data`, `create`, …).
 * @throws {CyphraValidationError} With `issues` listing every broken rule.
 */
export function validateWriteArgs(
  schema: SchemaModel,
  model: ResolvedNodeModel,
  op: "create" | "createMany" | "update" | "updateMany" | "upsert",
  args: unknown,
): void {
  if (!hasRules(schema) || !isPlainObject(args)) return;
  const c = new Collector(schema);
  switch (op) {
    case "create":
      c.node(model, args.data, ["data"], "create");
      break;
    case "createMany":
      if (Array.isArray(args.data)) {
        args.data.forEach((d, i) => c.node(model, d, ["data", i], "create"));
      }
      break;
    case "update":
    case "updateMany":
      c.node(model, args.data, ["data"], "update");
      break;
    case "upsert": {
      // The unique key of `where` is what a created node gets: check its values too.
      const where = isPlainObject(args.where) ? args.where : {};
      const scalars = model.fields.filter((f): f is ResolvedScalarField => f.kind === "scalar");
      const keyFields = new Set(model.uniqueFields);
      const plain = (v: unknown) => v !== undefined && v !== null && !isPlainObject(v);
      const top = Object.fromEntries(
        Object.entries(where).filter(([k, v]) => keyFields.has(k) && plain(v)),
      );
      c.scalars(model.name, scalars, top, ["where"], "update");
      for (const cu of model.compoundUniques ?? []) {
        const v = where[cu.key];
        if (isPlainObject(v)) c.scalars(model.name, scalars, v, ["where", cu.key], "update");
      }
      // Key fields set by `where` are not absent from `create`.
      const given = Object.keys(top).concat(
        (model.compoundUniques ?? []).flatMap((cu) =>
          isPlainObject(where[cu.key]) ? cu.fields : [],
        ),
      );
      c.node(model, args.create, ["create"], "create", given);
      c.node(model, args.update, ["update"], "update");
      break;
    }
  }
  if (c.issues.length) throw rulesError(`${model.name}.${op}`, c.issues);
}

const ruled = new WeakMap<SchemaModel, boolean>();

/** Whether any field of the schema has a validation rule (cached per schema model). */
function hasRules(schema: SchemaModel): boolean {
  let has = ruled.get(schema);
  if (has === undefined) {
    has = [
      ...schema.nodes.flatMap((n) => n.fields),
      ...schema.relationships.flatMap((r) => r.properties),
    ].some((f) => f.kind === "scalar" && Boolean(f.rules?.length));
    ruled.set(schema, has);
  }
  return has;
}

/**
 * A `@min` / `@max` check of the value a numeric update operator produces, for a Cypher guard:
 * `result` is the Cypher expression of the new value (`(n.age + $p0)`), `bound` its encoded
 * limit parameter.
 */
export type NumericCheck = {
  readonly field: ResolvedScalarField;
  readonly rule: "min" | "max";
  readonly result: string;
  readonly bound: string;
};

/**
 * A Cypher expression listing the checks a node's update would break, as `"field:rule"` strings
 * (an empty list when none), or `null` when there is nothing to check.
 */
export function numericGuard(checks: readonly NumericCheck[]): string | null {
  if (checks.length === 0) return null;
  const cases = checks.map(
    (c) =>
      `CASE WHEN ${c.result} ${c.rule === "min" ? "<" : ">"} ${c.bound} THEN ${JSON.stringify(`${c.field.name}:${c.rule}`)} END`,
  );
  return `[x IN [${cases.join(", ")}] WHERE x IS NOT NULL]`;
}

/** Throw for the `"field:rule"` entries a guard returned (nothing when there are none). */
export function throwGuardIssues(
  op: string,
  model: ResolvedNodeModel,
  checks: readonly NumericCheck[],
  broken: unknown,
  path: Path,
): void {
  if (!Array.isArray(broken) || broken.length === 0) return;
  const issues: ValidationIssue[] = [];
  for (const entry of broken as string[]) {
    const check = checks.find((c) => `${c.field.name}:${c.rule}` === entry);
    if (!check) continue;
    const r = check.field.rules?.find((x) => x.rule === check.rule);
    const limit = r && (r.rule === "min" || r.rule === "max") ? String(r.value) : "";
    issues.push({
      path: [...path, check.field.name],
      model: model.name,
      field: check.field.name,
      rule: check.rule,
      message: `must be ${check.rule === "min" ? "at least" : "at most"} ${limit} (the update would make it ${check.rule === "min" ? "smaller" : "larger"}).`,
    });
  }
  if (issues.length) throw rulesError(`${model.name}.${op}`, issues);
}
