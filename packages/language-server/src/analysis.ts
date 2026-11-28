import {
  ancestorInterfaces,
  parentInterfaces,
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
  const owner = /^(Node|Interface|Relationship|Enum|Union) "([^"]+)"/.exec(message);
  if (!owner) return undefined;
  const kind = owner[1] === "Interface" ? "Node" : (owner[1] as Declaration["kind"]);
  const decl = doc.declarations.find((d) => d.name === owner[2] && d.kind === kind);
  if (!decl) return undefined;
  const rest = message.slice(owner[0].length);
  const fallback = span(decl.nameLoc);
  if (decl.kind === "Node") {
    const s = locateImplementsError(rest, decl, doc);
    if (s) return s;
  }

  if (decl.kind === "Union") {
    // `member X is listed twice` (the second one), `member X, which is …`, `X is a member twice
    // (… and through Y)` (on Y, or on X when listed directly).
    const twice = /^: (\w+) is a member twice \(.* (?:and through (\w+)|and directly)\)/.exec(rest);
    if (twice) {
      const at = decl.members.lastIndexOf(twice[2] ?? twice[1]!);
      return span(decl.memberLocs?.[at]) ?? fallback;
    }
    const member = /^: member (\w+)( is listed twice)?/.exec(rest);
    if (member) {
      const idx = decl.members.map((m, i) => (m === member[1] ? i : -1)).filter((i) => i >= 0);
      return span(decl.memberLocs?.[(member[2] ? idx[1] : idx[0]) ?? -1]) ?? fallback;
    }
    return fallback;
  }

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

/**
 * `implements` / `extends` errors: the interface name in the list the message is about (for a
 * field or an `@id` inherited from further up, the name it is inherited through).
 */
function locateImplementsError(
  rest: string,
  decl: NodeDeclaration,
  doc: SchemaDocument,
): Span | undefined {
  const implemented = decl.implements ?? [];
  const extended = decl.extends ?? [];
  const at = (word: "implements" | "extends", name: string | undefined, nth = 0) => {
    const names = word === "implements" ? implemented : extended;
    const locs = word === "implements" ? decl.implementsLocs : decl.extendsLocs;
    const idx = names.map((n, i) => (n === name ? i : -1)).filter((i) => i >= 0);
    return span(locs?.[idx[nth] ?? idx[0] ?? -1]);
  };
  const parents = parentInterfaces(decl);
  const word = decl.abstract ? "extends" : "implements";
  /** The parent `name` is, or that inherits from it. */
  const through = (name: string) =>
    parents.find((p) => {
      if (p === name) return true;
      const d = doc.declarations.find((x) => x.name === p);
      return d?.kind === "Node" && ancestorInterfaces(doc, d).includes(name);
    });
  const notInterface = /^: (implements|extends) (\w+), which is not an interface/.exec(rest);
  if (notInterface) return at(notInterface[1] as typeof word, notInterface[2]);
  const twice = /^: (implements|extends) (\w+) twice/.exec(rest);
  if (twice) return at(twice[1] as typeof word, twice[2], 1);
  if (/^: an interface (?:cannot implement|extends other interfaces)/.test(rest)) {
    return at("implements", implemented[0]);
  }
  if (/^: a node implements interfaces/.test(rest)) return at("extends", extended[0]);
  const cycle = /^: interfaces cannot extend themselves \(\w+ extends (\w+)/.exec(rest);
  if (cycle) return at("extends", cycle[1]);
  const both = /^: field "[^"]+" is declared by both \w+ and (\w+)/.exec(rest);
  if (both) return at(word, through(both[1]!));
  const ids = /^: \w+ and (\w+) both declare an @id/.exec(rest);
  if (ids) return at(word, through(ids[1]!));
  return undefined;
}

function locateAttributeError(
  rest: string,
  decl: NodeDeclaration | RelationshipDeclaration,
  name: string,
): Span | undefined {
  const attrs = (decl.attributes ?? []).filter((a) => a.name === name);
  if (attrs.length === 0) return undefined;
  // `@@labels: X is the label of …` / `@@labels lists X twice`: the label in the list.
  const fieldName =
    /field "([^"]+)"/.exec(rest)?.[1] ??
    (name === "labels"
      ? /@@labels(?::| lists) (\w+) (?:is the label|starts with|twice)/.exec(rest)?.[1]
      : undefined);
  const quoted = /"([^"]+)"/.exec(rest)?.[1];
  // `fields [a, b] are already …`: the later of the attributes over those fields.
  const covered = /fields \[([^\]]*)\] are already/.exec(rest)?.[1];
  const suffix = name === "fulltext" ? "fulltext" : name === "unique" ? "unique" : "idx";
  // Several attributes of this kind: pick the one the message is about.
  const pick =
    (covered !== undefined
      ? attrs.filter((a) => (a.fields ?? []).join(", ") === covered).pop()
      : undefined) ??
    attrs.find((a) => fieldName !== undefined && a.fields?.includes(fieldName)) ??
    attrs.find(
      (a) =>
        quoted !== undefined &&
        a.args.some((x) => x.value.kind !== "number" && String(x.value.value) === quoted),
    ) ??
    attrs.find(
      (a) =>
        quoted !== undefined &&
        `${decl.name}_${(a.fields ?? []).join("_")}_${suffix}`.replace(/[^A-Za-z0-9_]/g, "_") ===
          quoted,
    ) ??
    attrs.find((a) => /needs a list/.test(rest) && (a.fields?.length ?? 0) < 2) ??
    attrs[0]!;
  if (fieldName && pick.fields) {
    const idx = pick.fields.map((f, i) => (f === fieldName ? i : -1)).filter((i) => i >= 0);
    // "lists field twice" points at the second occurrence.
    const i = /twice/.test(rest) ? (idx[1] ?? idx[0]) : idx[0];
    if (i !== undefined) return span(pick.fieldLocs?.[i]);
  }
  const twice = /@@\w+ (\w+) given twice/.exec(rest);
  if (twice) return argSpan(pick, twice[1]!, 1);
  const unknownArg = /unknown @@\w+ argument "(\w+)"/.exec(rest);
  if (unknownArg) {
    const a = pick.args.find((x) => x.key === unknownArg[1]);
    return span(a?.keyLoc ?? a?.loc);
  }
  for (const key of ["analyzer", "name", "eventuallyConsistent"]) {
    if (
      new RegExp(
        `@@\\w+ ${key}\\b|unknown @@\\w+ ${key}|${key} "[^"]*" is already used|key "[^"]*" is already a field`,
      ).test(rest)
    ) {
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
  /** The decorator that makes `f` a relation field (`@out`, `@in` or `@relationship`). */
  const relDecs = f.decorators.filter(
    (d) => d.name === "out" || d.name === "in" || d.name === "relationship",
  );
  const relDec = relDecs[0];
  if (/^relation fields need @/.test(rest)) {
    return relDec ? (argSpan(relDec, "type") ?? decoratorSpan(relDec)) : typeNameSpan(f);
  }
  if (/^@(out|in) needs the relationship type/.test(rest)) {
    return relDec ? (argSpan(relDec, "type") ?? decoratorSpan(relDec)) : undefined;
  }
  if (/^(use one of @out|at most one @(out|in|relationship) )/.test(rest)) {
    const d = relDecs[1] ?? relDec;
    return d ? decoratorSpan(d) : undefined;
  }
  if (/^@(out|in|relationship)\(.*\) has the same direction as/.test(rest)) {
    return relDec ? (argSpan(relDec, "type") ?? decoratorSpan(relDec)) : undefined;
  }
  if (/^direction must be/.test(rest)) {
    return relDec ? (argSpan(relDec, "direction") ?? decoratorSpan(relDec)) : undefined;
  }
  const relArg =
    /^(?:onDelete must be|@(?:relationship|out|in) (\w+) given twice|onDelete \w+ conflicts)/.exec(
      rest,
    );
  if (relArg) {
    const key = relArg[1] ?? "onDelete";
    return relDec ? (argSpan(relDec, key, relArg[1] ? 1 : 0) ?? decoratorSpan(relDec)) : undefined;
  }
  const unknownRelArg = /^unknown @(?:relationship|out|in) argument "(\w*)"/.exec(rest);
  if (unknownRelArg) {
    const a = relDec?.args.find((x) => x.key === unknownRelArg[1]);
    return span(a?.keyLoc ?? a?.loc);
  }
  if (/^several relationship models match/.test(rest)) {
    return relDec ? decoratorSpan(relDec) : undefined;
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
  // Validation rules: `@length min must be …`, `@regex pattern does not compile`, `unknown @min
  // argument "x"`, `@email takes no arguments`, `@x is not valid on a … field`.
  const ruleArg = /^@(\w+) (min|max|value|pattern|flags)\b/.exec(rest);
  if (ruleArg) {
    const d = dec(ruleArg[1]!);
    if (d) return argSpan(d, ruleArg[2]!, /given twice/.test(rest) ? 1 : 0) ?? decoratorSpan(d);
  }
  const unknownArg = /^unknown @(\w+) argument "(\w+)"/.exec(rest);
  if (unknownArg) {
    const a = dec(unknownArg[1]!)?.args.find((x) => x.key === unknownArg[2]);
    if (a) return span(a.keyLoc ?? a.loc);
  }
  const positional = /^@(\w+) takes /.exec(rest);
  if (positional) {
    const d = dec(positional[1]!);
    const a = d?.args.find((x) => x.key === "");
    if (d) return span(a?.loc) ?? decoratorSpan(d);
  }
  if (/^@min \(.*\) is above @max/.test(rest)) {
    const d = dec("max");
    if (d) return decoratorSpan(d);
  }
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
