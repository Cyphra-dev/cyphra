/**
 * Schema warnings: things that are valid but probably a mistake. Unlike validation errors they do
 * not stop `cyphra validate` or `cyphra generate`; editors show them as warnings.
 *
 * @packageDocumentation
 */

import type { SchemaDocument, SourceRange } from "./ast.js";

/** Codes of {@link SchemaWarning}. */
export type SchemaWarningCode = "similar-relationship-types";

/** A valid but suspicious part of a schema (see {@link schemaWarnings}). */
export type SchemaWarning = {
  readonly code: SchemaWarningCode;
  readonly message: string;
  /** Where it is (only when the document was parsed with `{ locations: true }`). */
  readonly loc?: SourceRange;
};

/** A relationship type as written in the schema: in a field or as a `relationship` block. */
export type RelationshipTypeUse = {
  readonly relType: string;
  /** The node, interface or relationship block it is written in. */
  readonly owner: string;
  /** The field it is written on (absent for a `relationship` block). */
  readonly field?: string;
  /** Range of the type itself (`AUTHORED` in `@out(AUTHORED)`), with `{ locations: true }`. */
  readonly loc?: SourceRange;
};

/**
 * Every relationship type the schema writes, in source order: the `@out(T)` / `@in(T)` /
 * `@relationship(type: "T")` of each relation field and the type of each `relationship` block.
 */
export function relationshipTypeUses(doc: SchemaDocument): RelationshipTypeUse[] {
  const out: RelationshipTypeUse[] = [];
  for (const d of doc.declarations) {
    if (d.kind === "Relationship") {
      out.push({
        relType: d.relType,
        owner: d.name,
        ...(d.relTypeLoc ? { loc: d.relTypeLoc } : {}),
      });
      continue;
    }
    if (d.kind !== "Node") continue;
    for (const f of d.fields) {
      if (f.kind !== "Relational") continue;
      for (const dec of f.decorators) {
        if (dec.name !== "out" && dec.name !== "in" && dec.name !== "relationship") continue;
        const arg = dec.args.find((a) => a.key === "type");
        const kind = dec.name === "relationship" ? "string" : "identifier";
        if (!arg || arg.value.kind !== kind || arg.value.value === "") continue;
        const loc = arg.valueLoc ?? arg.loc;
        out.push({
          relType: String(arg.value.value),
          owner: d.name,
          field: f.name,
          ...(loc ? { loc } : {}),
        });
      }
    }
  }
  return out;
}

/** Levenshtein distance between `a` and `b`, or `max + 1` once it is known to exceed `max`. */
function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const v = Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + cost);
      row.push(v);
      best = Math.min(best, v);
    }
    if (best > max) return max + 1;
    prev = row;
  }
  return prev[b.length]!;
}

/**
 * `true` when two different relationship types look like one misspelled: they differ only in
 * case, or by one or two edits (a type of a few letters needs more than half of it to change
 * before it counts as different: `IN` and `ON` are not flagged).
 */
export function similarRelationshipTypes(a: string, b: string): boolean {
  if (a === b) return false;
  if (a.toLowerCase() === b.toLowerCase()) return true;
  const d = editDistance(a, b, 2);
  return d <= 2 && d * 2 < Math.min(a.length, b.length);
}

/**
 * Warnings about a parsed schema: relationship types that are nearly identical
 * (`AUTHORED` and `AUTHORD`, `Follows` and `FOLLOWS`), which are different edge types to the
 * database but usually a typo. Each pair is reported once, at the first use of the type written
 * less often.
 *
 * @param doc - A parsed document (with `{ locations: true }` for warnings with a `loc`).
 */
export function schemaWarnings(doc: SchemaDocument): SchemaWarning[] {
  const uses = relationshipTypeUses(doc);
  const byType = new Map<string, RelationshipTypeUse[]>();
  for (const u of uses) {
    const list = byType.get(u.relType);
    if (list) list.push(u);
    else byType.set(u.relType, [u]);
  }
  const types = [...byType.keys()];
  const warnings: SchemaWarning[] = [];
  for (let i = 0; i < types.length; i++) {
    for (let j = i + 1; j < types.length; j++) {
      const [a, b] = [types[i]!, types[j]!];
      if (!similarRelationshipTypes(a, b)) continue;
      const [rare, common] = byType.get(b)!.length <= byType.get(a)!.length ? [b, a] : [a, b];
      const at = byType.get(rare)![0]!;
      const where = (t: string) =>
        byType
          .get(t)!
          .map((u) => (u.field ? `${u.owner}.${u.field}` : `relationship ${u.owner}`))
          .join(", ");
      warnings.push({
        code: "similar-relationship-types",
        message: `Relationship types ${rare} (${where(rare)}) and ${common} (${where(common)}) are nearly identical: they are different edge types, is one of them a typo?`,
        ...(at.loc ? { loc: at.loc } : {}),
      });
    }
  }
  return warnings;
}
