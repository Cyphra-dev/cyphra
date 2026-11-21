import type { Declaration, SchemaDocument } from "@cyphra/schema";
import { span, typeNameSpan, type Analysis, type Span } from "./analysis.js";

/** A model or enum name in the text: its declaration or a reference to it. */
export type Occurrence = Span & {
  readonly name: string;
  readonly declaration: boolean;
};

export const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Declaration names and every place a field type, `from` or `to` names them. */
export function occurrences(doc: SchemaDocument): Occurrence[] {
  const out: Occurrence[] = [];
  const add = (name: string, s: Span | undefined, declaration = false) => {
    if (s) out.push({ name, start: s.start, end: s.end, declaration });
  };
  for (const d of doc.declarations) {
    add(d.name, span(d.nameLoc), true);
    if (d.kind === "Enum") continue;
    if (d.kind === "Relationship") {
      add(d.from, span(d.fromLoc));
      add(d.to, span(d.toLoc));
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

/** Target of go-to-definition at `offset`: a model / enum name, or a field named by `@@fulltext`. */
export function definitionAt(a: Analysis, offset: number): Span | undefined {
  const doc = a.doc;
  if (!doc) return undefined;
  const o = occurrenceAt(doc, offset);
  if (o) return span(declarationNamed(doc, o.name)?.nameLoc);
  for (const d of doc.declarations) {
    if (d.kind === "Enum") continue;
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

/** Every occurrence of the model or enum at `offset`. */
export function referencesAt(a: Analysis, offset: number, includeDeclaration: boolean): Span[] {
  const doc = a.doc;
  if (!doc) return [];
  const o = occurrenceAt(doc, offset);
  if (!o || !declarationNamed(doc, o.name)) return [];
  return occurrences(doc).filter(
    (x) => x.name === o.name && (includeDeclaration || !x.declaration),
  );
}

/** The model or enum name rename would change at `offset`. */
export function renameTargetAt(a: Analysis, offset: number): Occurrence | undefined {
  const doc = a.doc;
  if (!doc) return undefined;
  const o = occurrenceAt(doc, offset);
  return o && declarationNamed(doc, o.name) ? o : undefined;
}

/**
 * Edits renaming the model or enum at `offset` to `newName`.
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
  if (builtinTypes.includes(newName)) throw new Error(`${newName} is a built-in type name.`);
  if (newName !== target.name && declarationNamed(a.doc, newName)) {
    throw new Error(`"${newName}" is already declared.`);
  }
  return occurrences(a.doc).filter((x) => x.name === target.name);
}
