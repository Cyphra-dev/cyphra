import type { NodeDeclaration } from "@cyphra/schema";
import { span, type Analysis, type Span } from "./analysis.js";
import { inverseFields, relationFields, type OwnedRelation } from "./relTypes.js";

/** A text edit: replace `span` with `newText`. */
export type TextEdit = { readonly span: Span; readonly newText: string };

/** An editor-neutral code action (the server maps it to an LSP `CodeAction`). */
export type CodeAction = {
  readonly title: string;
  readonly kind: "quickfix";
  readonly edits: readonly TextEdit[];
};

const lcfirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/** A naive English plural, for a field name (`user` → `users`, `category` → `categories`). */
function plural(s: string): string {
  if (/[^aeiou]y$/.test(s)) return `${s.slice(0, -1)}ies`;
  if (/(s|x|z|ch|sh)$/.test(s)) return `${s}es`;
  return `${s}s`;
}

/** The field line of the inverse of `r`, to add to its target. */
function inverseLine(r: OwnedRelation, target: NodeDeclaration): string {
  const self = r.owner.name === target.name;
  // One-to-many is the common case: the inverse of a to-many field is an optional to-one, and
  // the inverse of a to-one field a to-many one. A self-relationship keeps its cardinality.
  const many = self ? r.field.cardinality === "many" : r.field.cardinality !== "many";
  const base = self
    ? `${r.field.name}Inverse`
    : many
      ? plural(lcfirst(r.owner.name))
      : lcfirst(r.owner.name);
  const taken = new Set(target.fields.map((f) => f.name));
  let name = base;
  for (let i = 2; taken.has(name); i++) name = `${base}${i}`;
  const type = many ? `${r.owner.name}[]` : `${r.owner.name}?`;
  const flip = r.direction === "OUT" ? "IN" : "OUT";
  const old = r.field.decorators.some((d) => d.name === "relationship");
  const dec = old
    ? `@relationship(type: ${JSON.stringify(r.relType)}, direction: ${flip})`
    : `@${flip === "OUT" ? "out" : "in"}(${r.relType})`;
  return `${name} ${type} ${dec}`;
}

/** Where a new field line goes in `d`: after its last field, or after its `{`. */
function insertion(a: Analysis, d: NodeDeclaration): { at: number; indent: string } | undefined {
  const last = d.fields.at(-1);
  const end = span(last?.loc);
  if (last && end) {
    const lineStart = a.text.lastIndexOf("\n", end.start - 1) + 1;
    const lead = a.text.slice(lineStart, end.start);
    return { at: end.end, indent: /^\s*$/.test(lead) ? lead : "  " };
  }
  const s = span(d.loc);
  if (!s) return undefined;
  const open = a.text.indexOf("{", s.start);
  return open < 0 || open >= s.end ? undefined : { at: open + 1, indent: "  " };
}

/**
 * Code actions for `range`: on a relation field without an inverse, "Add inverse field on
 * <Target>" (a field on the target reading the same edges the other way).
 */
export function codeActionsAt(a: Analysis, range: Span): CodeAction[] {
  const doc = a.doc;
  if (!doc) return [];
  const out: CodeAction[] = [];
  for (const r of relationFields(doc)) {
    const loc = span(r.field.loc);
    if (!loc || loc.end < range.start || loc.start > range.end) continue;
    if (inverseFields(doc, r).length) continue;
    const target = doc.declarations.find(
      (d): d is NodeDeclaration => d.kind === "Node" && d.name === r.field.target,
    );
    // A union has no fields of its own.
    if (!target) continue;
    const at = insertion(a, target);
    if (!at) continue;
    out.push({
      title: `Add inverse field on ${target.name}`,
      kind: "quickfix",
      edits: [
        {
          span: { start: at.at, end: at.at },
          newText: `\n${at.indent}${inverseLine(r, target)}`,
        },
      ],
    });
  }
  return out;
}
