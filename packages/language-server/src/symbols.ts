import type { Declaration, SchemaDocument } from "@cyphra/schema";
import { span, typeNameSpan, type Analysis, type Span } from "./analysis.js";
import { blocksOf, relTypeUseAt, relTypeUses } from "./relTypes.js";

/** A model or enum name in the text: its declaration or a reference to it. */
export type Occurrence = Span & {
  readonly name: string;
  readonly declaration: boolean;
};

export const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Declaration names and every place a field type, `from`, `to`, `implements` or `extends` names
 * them.
 */
export function occurrences(doc: SchemaDocument): Occurrence[] {
  const out: Occurrence[] = [];
  const add = (name: string, s: Span | undefined, declaration = false) => {
    if (s) out.push({ name, start: s.start, end: s.end, declaration });
  };
  for (const d of doc.declarations) {
    add(d.name, span(d.nameLoc), true);
    if (d.kind === "Enum") continue;
    if (d.kind === "Union") {
      d.members.forEach((n, i) => add(n, span(d.memberLocs?.[i])));
      continue;
    }
    if (d.kind === "Relationship") {
      if (d.from !== undefined) add(d.from, span(d.fromLoc));
      if (d.to !== undefined) add(d.to, span(d.toLoc));
    } else {
      (d.implements ?? []).forEach((n, i) => add(n, span(d.implementsLocs?.[i])));
      (d.extends ?? []).forEach((n, i) => add(n, span(d.extendsLocs?.[i])));
    }
    for (const f of d.fields) {
      if (f.kind === "Relational") add(f.target, typeNameSpan(f));
      else if (f.type.name === "Enum" && f.type.enum) add(f.type.enum, typeNameSpan(f));
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

export function occurrenceAt(doc: SchemaDocument, offset: number): Occurrence | undefined {
  return occurrences(doc).find((o) => offset >= o.start && offset <= o.end);
}

export function declarationNamed(doc: SchemaDocument, name: string): Declaration | undefined {
  return doc.declarations.find((d) => d.name === name);
}

/**
 * Target of go-to-definition at `offset`: a model / enum name, a field named by `@@fulltext`, or
 * the `relationship` block of a relationship type (`@out(AUTHORED)` goes to
 * `relationship AUTHORED { … }`, or to the `type "AUTHORED"` of a long-form block).
 */
export function definitionAt(a: Analysis, offset: number): Span | undefined {
  const doc = a.doc;
  if (!doc) return undefined;
  const use = relTypeUseAt(doc, a.text, offset);
  if (use) {
    const block = blocksOf(doc, use.relType)[0];
    if (!block) return undefined;
    return relTypeUses(doc, a.text).find((u) => u.block === block);
  }
  const o = occurrenceAt(doc, offset);
  if (o) return span(declarationNamed(doc, o.name)?.nameLoc);
  for (const d of doc.declarations) {
    if (d.kind === "Enum" || d.kind === "Union") continue;
    for (const attr of d.attributes ?? []) {
      const i = (attr.fieldLocs ?? []).findIndex(
        (l) => offset >= l.start.offset && offset <= l.end.offset,
      );
      if (i < 0) continue;
      const field = d.fields.find((f) => f.name === attr.fields?.[i]);
      return span(field?.nameLoc);
    }
  }
  return undefined;
}

/** Every occurrence of the model, enum or relationship type at `offset`. */
export function referencesAt(a: Analysis, offset: number, includeDeclaration: boolean): Span[] {
  const doc = a.doc;
  if (!doc) return [];
  const use = relTypeUseAt(doc, a.text, offset);
  if (use) {
    return relTypeUses(doc, a.text)
      .filter((u) => u.relType === use.relType && (includeDeclaration || u.kind !== "block"))
      .map(({ start, end }) => ({ start, end }));
  }
  const o = occurrenceAt(doc, offset);
  if (!o || !declarationNamed(doc, o.name)) return [];
  return occurrences(doc).filter(
    (x) => x.name === o.name && (includeDeclaration || !x.declaration),
  );
}

/** The model, enum or relationship type name rename would change at `offset`. */
export function renameTargetAt(a: Analysis, offset: number): Occurrence | undefined {
  const doc = a.doc;
  if (!doc) return undefined;
  const use = relTypeUseAt(doc, a.text, offset);
  if (use) {
    return { name: use.relType, start: use.start, end: use.end, declaration: use.kind === "block" };
  }
  const o = occurrenceAt(doc, offset);
  return o && declarationNamed(doc, o.name) ? o : undefined;
}

/**
 * Edits renaming the model, enum or relationship type at `offset` to `newName` (a relationship
 * type is renamed in every field using it and in its `relationship` block).
 *
 * @throws {Error} When `newName` is not an identifier or is already declared.
 */
export function renameEdits(
  a: Analysis,
  offset: number,
  newName: string,
  builtinTypes: readonly string[],
): Span[] | undefined {
  const target = renameTargetAt(a, offset);
  if (!target || !a.doc) return undefined;
  if (!IDENTIFIER.test(newName)) throw new Error(`"${newName}" is not a valid name.`);
  const use = relTypeUseAt(a.doc, a.text, offset);
  if (use) {
    // A relationship type: every @out / @in / @relationship field and its block.
    const uses = relTypeUses(a.doc, a.text);
    if (newName !== use.relType && uses.some((u) => u.relType === newName)) {
      throw new Error(`${newName} is already a relationship type of this schema.`);
    }
    const short = blocksOf(a.doc, use.relType).some((b) => b.from === undefined);
    if (short && newName !== use.relType && declarationNamed(a.doc, newName)) {
      throw new Error(`"${newName}" is already declared.`);
    }
    return uses.filter((u) => u.relType === use.relType).map(({ start, end }) => ({ start, end }));
  }
  if (builtinTypes.includes(newName)) throw new Error(`${newName} is a built-in type name.`);
  if (newName !== target.name && declarationNamed(a.doc, newName)) {
    throw new Error(`"${newName}" is already declared.`);
  }
  return occurrences(a.doc).filter((x) => x.name === target.name);
}
