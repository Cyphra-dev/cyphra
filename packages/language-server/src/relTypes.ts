import type {
  Decorator,
  NodeDeclaration,
  RelationalNodeField,
  RelationshipDeclaration,
  SchemaDocument,
} from "@cyphra/schema";
import { span, type Span } from "./analysis.js";

/**
 * A relationship type written in the schema: the `AUTHORED` of `@out(AUTHORED)` /
 * `@in(AUTHORED)`, the text of `@relationship(type: "AUTHORED")` or `type "AUTHORED"`, or the
 * name of a `relationship AUTHORED { … }` block. The span covers the type only (inside the quotes
 * of a string).
 */
export type RelTypeUse = Span & {
  readonly relType: string;
  /** The node, interface or `relationship` block it is written in. */
  readonly owner: string;
  /** A relation field, or the type of a `relationship` block. */
  readonly kind: "field" | "block";
  /** The relation field (for `kind: "field"`). */
  readonly field?: RelationalNodeField;
  /** Direction of the field's edges (for `kind: "field"`). */
  readonly direction?: "OUT" | "IN";
  /** The decorator naming it (for `kind: "field"`). */
  readonly decorator?: Decorator;
  /** The block (for `kind: "block"`). */
  readonly block?: RelationshipDeclaration;
  /** Written as a string (`@relationship(type: "…")`, `type "…"`). */
  readonly quoted: boolean;
};

/** The decorator making `f` a relation field, with the type and direction it gives. */
export function relationDecorator(
  f: RelationalNodeField,
): { decorator: Decorator; relType: string; direction: "OUT" | "IN"; quoted: boolean } | undefined {
  for (const d of f.decorators) {
    if (d.name !== "out" && d.name !== "in" && d.name !== "relationship") continue;
    const arg = d.args.find((a) => a.key === "type");
    if (!arg) return undefined;
    if (d.name === "relationship") {
      if (arg.value.kind !== "string" || arg.value.value === "") return undefined;
      const dir = d.args.find((a) => a.key === "direction")?.value;
      const direction = dir?.kind === "identifier" && dir.value === "IN" ? "IN" : "OUT";
      return { decorator: d, relType: arg.value.value, direction, quoted: true };
    }
    if (arg.value.kind !== "identifier") return undefined;
    return {
      decorator: d,
      relType: arg.value.value,
      direction: d.name === "out" ? "OUT" : "IN",
      quoted: false,
    };
  }
  return undefined;
}

/** The text range of a type: an identifier as is, a string without its quotes (when unescaped). */
function typeSpan(
  text: string,
  s: Span | undefined,
  value: string,
  quoted: boolean,
): Span | undefined {
  if (!s) return undefined;
  if (!quoted) return s;
  const inner = { start: s.start + 1, end: s.end - 1 };
  return text.slice(inner.start, inner.end) === value ? inner : undefined;
}

/** Every relationship type written in `doc`, in source order. */
export function relTypeUses(doc: SchemaDocument, text: string): RelTypeUse[] {
  const out: RelTypeUse[] = [];
  for (const d of doc.declarations) {
    if (d.kind === "Relationship") {
      const short = d.from === undefined;
      const s = typeSpan(text, span(short ? d.nameLoc : d.relTypeLoc), d.relType, !short);
      if (s)
        out.push({
          ...s,
          relType: d.relType,
          owner: d.name,
          kind: "block",
          block: d,
          quoted: !short,
        });
      continue;
    }
    if (d.kind !== "Node") continue;
    for (const f of d.fields) {
      if (f.kind !== "Relational") continue;
      const rel = relationDecorator(f);
      if (!rel) continue;
      const arg = rel.decorator.args.find((a) => a.key === "type");
      const s = typeSpan(text, span(arg?.valueLoc ?? arg?.loc), rel.relType, rel.quoted);
      if (!s) continue;
      out.push({
        ...s,
        relType: rel.relType,
        owner: d.name,
        kind: "field",
        field: f,
        direction: rel.direction,
        decorator: rel.decorator,
        quoted: rel.quoted,
      });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

/** The relationship type written at `offset`, if any. */
export function relTypeUseAt(
  doc: SchemaDocument,
  text: string,
  offset: number,
): RelTypeUse | undefined {
  return relTypeUses(doc, text).find((u) => offset >= u.start && offset <= u.end);
}

/** The `relationship` blocks typing `relType`: its short-form block, or its long-form ones. */
export function blocksOf(doc: SchemaDocument, relType: string): RelationshipDeclaration[] {
  return doc.declarations.filter(
    (d): d is RelationshipDeclaration => d.kind === "Relationship" && d.relType === relType,
  );
}

/** A relation field with the node or interface declaring it. */
export type OwnedRelation = {
  readonly owner: NodeDeclaration;
  readonly field: RelationalNodeField;
  readonly relType: string;
  readonly direction: "OUT" | "IN";
};

/** Every relation field of `doc` whose type and direction can be read. */
export function relationFields(doc: SchemaDocument): OwnedRelation[] {
  const out: OwnedRelation[] = [];
  for (const d of doc.declarations) {
    if (d.kind !== "Node") continue;
    for (const f of d.fields) {
      if (f.kind !== "Relational") continue;
      const rel = relationDecorator(f);
      if (rel) out.push({ owner: d, field: f, relType: rel.relType, direction: rel.direction });
    }
  }
  return out;
}

/**
 * The fields reading the same edges from the other end: on the target, towards the owner, with
 * the same type and the other direction (another field of the same node for a self-relationship).
 */
export function inverseFields(doc: SchemaDocument, of: OwnedRelation): OwnedRelation[] {
  return relationFields(doc).filter(
    (r) =>
      r.field !== of.field &&
      r.owner.name === of.field.target &&
      r.field.target === of.owner.name &&
      r.relType === of.relType &&
      r.direction !== of.direction,
  );
}
