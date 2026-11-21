import {
  parseSchemaSyntax,
  resolveSchema,
  SchemaValidationError,
  validateSchema,
  type Declaration,
  type Decorator,
  type ModelAttribute,
  type NodeDeclaration,
  type NodeField,
  type RelationshipDeclaration,
  type SchemaDocument,
  type SourceRange,
} from "@cyphra/schema";
import { scanDeclarations, tokenize, type ScannedDeclaration, type Token } from "./lexer.js";

/** A half-open offset range `[start, end)` in the document text. */
export type Span = { readonly start: number; readonly end: number };

export type SchemaProblem = {
  readonly message: string;
  readonly span: Span;
  readonly kind: "syntax" | "validation";
};

/** Everything the language features need about one version of a `.cyphra` document. */
export type Analysis = {
  readonly text: string;
  readonly tokens: readonly Token[];
  /** Declarations found by the tolerant scanner (available even when the text does not parse). */
  readonly scanned: readonly ScannedDeclaration[];
  /** The parsed AST with source ranges, when the text parses. */
  readonly doc?: SchemaDocument;
  /** The first syntax or validation error, as `cyphra validate` reports it. */
  readonly problem?: SchemaProblem;
};

export function span(loc: SourceRange | undefined): Span | undefined {
  return loc ? { start: loc.start.offset, end: loc.end.offset } : undefined;
}

type PeggySyntaxError = Error & {
  location?: { start: { offset: number }; end: { offset: number } };
};

/** Parse and validate a document like `cyphra validate` (parse, validate, resolve). */
export function analyze(text: string): Analysis {
  const tokens = tokenize(text);
  const scanned = scanDeclarations(tokens);
  let doc: SchemaDocument;
  try {
    doc = parseSchemaSyntax(text, { locations: true });
  } catch (err) {
    const e = err as PeggySyntaxError;
    if (err instanceof SchemaValidationError) {
      return {
        text,
        tokens,
        scanned,
        problem: { kind: "validation", message: e.message, span: { start: 0, end: 0 } },
      };
    }
    const start = e.location?.start.offset ?? 0;
    let end = e.location?.end.offset ?? start;
    // Give the squiggle at least one character.
    if (end === start && start < text.length && text[start] !== "\n") end = start + 1;
    return {
      text,
      tokens,
      scanned,
      problem: { kind: "syntax", message: e.message, span: { start, end } },
    };
  }
  try {
    validateSchema(doc);
    resolveSchema(doc);
  } catch (err) {
    // SchemaValidationError, or any other error the CLI would print the same way.
    if (!(err instanceof Error)) throw err;
    return {
      text,
      tokens,
      scanned,
      doc,
      problem: {
        kind: "validation",
        message: err.message,
        span: locateValidationError(err.message, doc) ?? firstLine(text),
      },
    };
  }
  return { text, tokens, scanned, doc };
}

function firstLine(text: string): Span {
  const nl = text.indexOf("\n");
  return { start: 0, end: nl < 0 ? text.length : nl };
}

/** The `n`-th (0-based) declaration named `name`. */
function declNamed(doc: SchemaDocument, name: string, n = 0): Declaration | undefined {
  return doc.declarations.filter((d) => d.name === name)[n];
}

/** Range of the name of a decorator (`@name`). */
function decoratorSpan(d: Decorator): Span | undefined {
  return span(d.loc);
}

function argSpan(d: Decorator | ModelAttribute, key: string, n = 0): Span | undefined {
  const a = d.args.filter((x) => x.key === key)[n];
  return a ? span(a.valueLoc ?? a.loc) : undefined;
}

/** The type name part of a field's type expression. */
export function typeNameSpan(f: NodeField): Span | undefined {
  const s = span(f.typeLoc);
  if (!s) return undefined;
  const name =
    f.kind === "Relational" ? f.target : f.type.name === "Enum" ? (f.type.enum ?? "") : f.type.name;
  return { start: s.start, end: s.start + name.length };
}

/**
 * Map a {@link SchemaValidationError} message (`Node "User" field "email": …`) to the source
 * range it is about: the field, its type, the decorator or argument the message names.
 */
export function locateValidationError(message: string, doc: SchemaDocument): Span | undefined {
  const dup = /^Duplicate declaration "([^"]+)"/.exec(message);
  if (dup) {
    const d = declNamed(doc, dup[1]!, 1) ?? declNamed(doc, dup[1]!);
    return span(d?.nameLoc);
  }
  const owner = /^(Node|Relationship|Enum) "([^"]+)"/.exec(message);
  if (!owner) return undefined;
  const decl = doc.declarations.find(
    (d) => d.name === owner[2] && d.kind === (owner[1] as Declaration["kind"]),
  );
  if (!decl) return undefined;
  const rest = message.slice(owner[0].length);
  const fallback = span(decl.nameLoc);

  if (decl.kind === "Enum") {
    const value = /duplicate value (\S+?)\.?$/.exec(rest);
    if (value) {
      const idx = decl.values.map((v, i) => (v === value[1] ? i : -1)).filter((i) => i >= 0);
      return span(decl.valueLocs?.[idx[1] ?? idx[0] ?? -1]) ?? fallback;
    }
    return fallback;
  }

  const dupField = /^: duplicate field "([^"]+)"/.exec(rest);
  if (dupField) {
    const same = decl.fields.filter((f) => f.name === dupField[1]);
    return span((same[1] ?? same[0])?.nameLoc) ?? fallback;
  }
  const unknownEnd = /^: unknown node "([^"]+)"/.exec(rest);
  if (unknownEnd && decl.kind === "Relationship") {
    return span(decl.from === unknownEnd[1] ? decl.fromLoc : decl.toLoc) ?? fallback;
  }
  if (/^ must have at most one @id/.test(rest) && decl.kind === "Node") {
    const ids = decl.fields.filter((f) => f.decorators.some((d) => d.name === "id"));
    const f = ids[1] ?? ids[0];
    const dec = f?.decorators.find((d) => d.name === "id");
    return (dec && decoratorSpan(dec)) ?? fallback;
  }
  const attr = /^:? (?:unknown model attribute )?@@(\w+)/.exec(rest);
  if (attr || /@@fulltext/.test(rest)) {
    return locateAttributeError(rest, decl, attr?.[1] ?? "fulltext") ?? fallback;
  }
  const field = /^ field "([^"]+)": /.exec(rest);
  if (field) {
    const f = decl.fields.find((x) => x.name === field[1]);
    if (!f) return fallback;
    return locateFieldError(rest.slice(field[0].length), f) ?? span(f.nameLoc) ?? fallback;
  }
  return fallback;
}

function locateAttributeError(
  rest: string,
  decl: NodeDeclaration | RelationshipDeclaration,
  name: string,
): Span | undefined {
  const attrs = (decl.attributes ?? []).filter((a) => a.name === name);
  if (attrs.length === 0) return undefined;
  const fieldName = /field "([^"]+)"/.exec(rest)?.[1];
  const quoted = /"([^"]+)"/.exec(rest)?.[1];
  // Several @@fulltext: pick the one the message is about.
  const pick =
    attrs.find((a) => fieldName !== undefined && a.fields?.includes(fieldName)) ??
    attrs.find(
      (a) =>
        quoted !== undefined &&
        a.args.some((x) => x.value.kind !== "number" && String(x.value.value) === quoted),
    ) ??
    attrs.find(
      (a) =>
        quoted !== undefined &&
        `${decl.name}_${(a.fields ?? []).join("_")}_fulltext`.replace(/[^A-Za-z0-9_]/g, "_") ===
          quoted,
    ) ??
    attrs.find((a) => /needs a list/.test(rest) && !a.fields?.length) ??
    attrs[0]!;
  if (fieldName && pick.fields) {
    const idx = pick.fields.map((f, i) => (f === fieldName ? i : -1)).filter((i) => i >= 0);
    // "lists field twice" points at the second occurrence.
    const i = /twice/.test(rest) ? (idx[1] ?? idx[0]) : idx[0];
    if (i !== undefined) return span(pick.fieldLocs?.[i]);
  }
  const twice = /@@fulltext (\w+) given twice/.exec(rest);
  if (twice) return argSpan(pick, twice[1]!, 1);
  const unknownArg = /unknown @@fulltext argument "(\w+)"/.exec(rest);
  if (unknownArg) {
    const a = pick.args.find((x) => x.key === unknownArg[1]);
    return span(a?.keyLoc ?? a?.loc);
  }
  for (const key of ["analyzer", "name", "eventuallyConsistent"]) {
    if (new RegExp(`@@fulltext ${key}\\b|unknown @@fulltext ${key}`).test(rest)) {
      const s = argSpan(pick, key);
      if (s) return s;
    }
  }
  return span(pick.loc);
}

function locateFieldError(rest: string, f: NodeField): Span | undefined {
  const dec = (name: string, n = 0) => f.decorators.filter((d) => d.name === name)[n];
  if (/^(unknown type|unknown node|Json\[\] is not supported|Vector dimensions)/.test(rest)) {
    return typeNameSpan(f) ?? span(f.typeLoc);
  }
  if (/^an @id field cannot be optional or a list/.test(rest)) return span(f.typeLoc);
  if (/^relation fields need @relationship/.test(rest)) {
    const r = dec("relationship");
    return r ? (argSpan(r, "type") ?? decoratorSpan(r)) : typeNameSpan(f);
  }
  if (/^direction must be/.test(rest)) {
    const r = dec("relationship");
    return r ? (argSpan(r, "direction") ?? decoratorSpan(r)) : undefined;
  }
  if (/^several relationship models match/.test(rest)) {
    const r = dec("relationship");
    return r ? decoratorSpan(r) : undefined;
  }
  if (
    /^(unknown default function|default |unsupported @default|a Json default|@default\()/.test(rest)
  ) {
    const d = dec("default");
    if (d) return argSpan(d, d.args[0]?.key ?? "value") ?? decoratorSpan(d);
  }
  if (/^vector index name/.test(rest)) {
    const v = dec("vectorIndex");
    if (v) return argSpan(v, "name") ?? decoratorSpan(v);
  }
  const vectorArg = /^@vectorIndex (similarity|quantization|name)\b/.exec(rest);
  if (vectorArg) {
    const v = dec("vectorIndex");
    if (v) return argSpan(v, vectorArg[1]!, /given twice/.test(rest) ? 1 : 0) ?? decoratorSpan(v);
  }
  const unknownVectorArg = /^unknown @vectorIndex argument "(\w+)"/.exec(rest);
  if (unknownVectorArg) {
    const a = dec("vectorIndex")?.args.find((x) => x.key === unknownVectorArg[1]);
    return span(a?.keyLoc ?? a?.loc);
  }
  if (/^Vector fields are only supported on node models/.test(rest)) return span(f.typeLoc);
  const count = /^at most one @(\w+)/.exec(rest);
  if (count) {
    const d = dec(count[1]!, 1) ?? dec(count[1]!);
    if (d) return decoratorSpan(d);
  }
  // "@index is redundant with @unique", "unknown decorator @x", "@id is only valid …": the
  // first decorator the message names.
  for (const m of rest.matchAll(/@(\w+)/g)) {
    const d = dec(m[1]!);
    if (d) return decoratorSpan(d);
  }
  return undefined;
}
