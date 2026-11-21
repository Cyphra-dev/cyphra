import type { Analysis, Span } from "./analysis.js";
import {
  BUILTIN_TYPES,
  DECORATORS,
  DEFAULT_FUNCTIONS,
  KEYWORD_DOCS,
  decoratorMarkdown,
  typeDoc,
  type DecoratorDoc,
} from "./docs.js";
import { scanFields, type ScannedDeclaration, type Token } from "./lexer.js";

export type CompletionKind =
  | "keyword"
  | "type"
  | "node"
  | "relationship"
  | "enum"
  | "enumMember"
  | "decorator"
  | "property"
  | "value"
  | "field"
  | "function"
  | "snippet";

/** An editor-neutral completion candidate (the server maps it to an LSP `CompletionItem`). */
export type Completion = {
  readonly label: string;
  readonly kind: CompletionKind;
  readonly detail?: string;
  readonly documentation?: string;
  /** Text to insert (a snippet when `snippet` is set); defaults to the label. */
  readonly insertText?: string;
  readonly snippet?: boolean;
  /** Text matched against what is typed (defaults to the label). */
  readonly filterText?: string;
  /** Range the insertion replaces (the identifier being typed). */
  readonly replace: Span;
  readonly sortText?: string;
};

type Ctx = {
  readonly a: Analysis;
  readonly replace: Span;
  readonly prefix: string;
};

const significant = (t: Token) => t.kind !== "comment" && t.kind !== "newline";

function names(a: Analysis, kind: ScannedDeclaration["kind"]): string[] {
  return [...new Set(a.scanned.filter((d) => d.kind === kind).map((d) => d.name))];
}

function enumValues(a: Analysis, name: string): string[] {
  const d = a.scanned.find((x) => x.kind === "enum" && x.name === name);
  if (!d || d.open < 0) return [];
  const last = d.close >= 0 ? d.close : a.tokens.length;
  return a.tokens
    .slice(d.open + 1, last)
    .filter((t) => t.kind === "ident")
    .map((t) => t.text);
}

/** Relationship types already used in the document (`type "X"`, `type: "X"`). */
function relationshipTypes(a: Analysis): string[] {
  const out = new Set<string>();
  const toks = a.tokens.filter(significant);
  toks.forEach((t, i) => {
    if (t.kind !== "string" || t.unterminated) return;
    const p1 = toks[i - 1];
    const p2 = toks[i - 2];
    if (p1?.text === "type" || (p1?.text === ":" && p2?.text === "type")) {
      out.add(t.text.slice(1, -1));
    }
  });
  return [...out];
}

function typeCompletions(ctx: Ctx, inNode: boolean): Completion[] {
  const { a, replace } = ctx;
  const out: Completion[] = BUILTIN_TYPES.map((t) =>
    t === "Vector"
      ? {
          label: "Vector(N)",
          kind: "type" as const,
          detail: "embedding of N floats",
          documentation: typeDoc("Vector"),
          insertText: "Vector(${1:1536})",
          snippet: true,
          replace,
          sortText: `1${t}`,
        }
      : { label: t, kind: "type" as const, documentation: typeDoc(t), replace, sortText: `1${t}` },
  );
  for (const e of names(a, "enum")) {
    out.push({ label: e, kind: "enum", detail: "enum", replace, sortText: `2${e}` });
  }
  if (inNode) {
    for (const n of names(a, "node")) {
      out.push({ label: n, kind: "node", detail: "node (relation)", replace, sortText: `3${n}` });
    }
  }
  return out;
}

type FieldKind = "scalar" | "relation" | "vector" | "unknown";

function fieldKind(a: Analysis, typeName: string | undefined): FieldKind {
  if (!typeName) return "unknown";
  if (typeName === "Vector") return "vector";
  if (BUILTIN_TYPES.includes(typeName) || names(a, "enum").includes(typeName)) return "scalar";
  if (names(a, "node").includes(typeName)) return "relation";
  return "unknown";
}

function decoratorCompletions(
  ctx: Ctx,
  kind: FieldKind,
  inRelationship: boolean,
  withAt: boolean,
  used: readonly string[],
): Completion[] {
  return DECORATORS.filter(
    (d) =>
      d.on !== "model" &&
      !used.includes(d.name) &&
      (kind === "unknown" || d.on === kind) &&
      !(inRelationship && (d.name === "id" || d.on !== "scalar")),
  ).map((d) => ({
    label: `@${d.name}`,
    kind: "decorator" as const,
    documentation: decoratorMarkdown(d),
    filterText: withAt ? `@${d.name}` : d.name,
    insertText: `${withAt ? "@" : ""}${d.snippet}`,
    snippet: true,
    replace: ctx.replace,
  }));
}

function attributeCompletions(ctx: Ctx, withAt: boolean): Completion[] {
  return DECORATORS.filter((d) => d.on === "model").map((d) => ({
    label: `@@${d.name}`,
    kind: "decorator" as const,
    documentation: decoratorMarkdown(d),
    filterText: withAt ? `@@${d.name}` : d.name,
    insertText: `${withAt ? "@@" : ""}${d.snippet}`,
    snippet: true,
    replace: ctx.replace,
  }));
}

/** Values of a decorator argument, or of `@default(…)` for the field's type. */
function valueCompletions(
  ctx: Ctx,
  dec: DecoratorDoc | undefined,
  key: string | undefined,
  fieldType: string | undefined,
): Completion[] {
  const { a, replace } = ctx;
  if (dec?.name === "default") {
    const out: Completion[] = [];
    for (const [fn, types] of Object.entries(DEFAULT_FUNCTIONS)) {
      if (!fieldType || types.includes(fieldType)) {
        out.push({ label: `${fn}()`, kind: "function", detail: types.join(" / "), replace });
      }
    }
    if (!fieldType || fieldType === "Boolean") {
      out.push(
        { label: "true", kind: "value", replace },
        { label: "false", kind: "value", replace },
      );
    }
    if (fieldType) {
      for (const v of enumValues(a, fieldType)) {
        out.push({ label: v, kind: "enumMember", detail: `${fieldType} value`, replace });
      }
    }
    return out;
  }
  const arg = dec?.args?.find((x) => x.name === key);
  if (!arg) return [];
  if (dec?.name === "relationship" && key === "type") {
    return relationshipTypes(a).map((t) => ({
      label: `"${t}"`,
      kind: "value" as const,
      detail: "relationship type in use",
      replace,
    }));
  }
  return (arg.values ?? []).map((v) => ({
    label: arg.string ? `"${v}"` : v,
    kind: "value" as const,
    replace,
  }));
}

/** Where the cursor is: the token being typed and the tokens before it. */
function locate(a: Analysis, offset: number) {
  const { tokens } = a;
  const at = tokens.find((t) => t.start < offset && offset <= t.end);
  const upTo = at?.kind === "ident" || at?.kind === "string" ? at.start : offset;
  return { at, before: tokens.filter((t) => t.end <= upTo) };
}

/** Completion candidates at `offset` (works on text that does not parse). */
export function completionsAt(a: Analysis, offset: number): Completion[] {
  const { at, before } = locate(a, offset);
  if (at?.kind === "comment") return [];
  if (at?.kind === "number") return [];
  if (at?.kind === "string" && (at.unterminated || offset < at.end)) {
    return stringCompletions(a, at, offset, before);
  }
  const prefixToken = at?.kind === "ident" && at.end === offset ? at : undefined;
  const replace = prefixToken
    ? { start: prefixToken.start, end: offset }
    : { start: offset, end: offset };
  const ctx: Ctx = {
    a,
    replace,
    prefix: prefixToken?.text.slice(0, offset - prefixToken.start) ?? "",
  };

  const decl = a.scanned.find(
    (d) =>
      d.open >= 0 &&
      a.tokens[d.open]!.start < offset &&
      (d.close < 0 || a.tokens[d.close]!.start >= offset),
  );
  if (!decl) return topLevelCompletions(ctx, before);
  if (decl.kind === "enum") return [];

  // Tokens of the current statement (a field or attribute line; parentheses may span lines).
  const inBlock = a.tokens.slice(decl.open + 1).filter((t) => t.end <= replace.start);
  let stmt: Token[] = [];
  let depth = 0;
  for (const t of inBlock) {
    if (t.kind === "newline") {
      if (depth === 0) stmt = [];
      continue;
    }
    if (t.kind === "comment") continue;
    if (t.text === "(" || t.text === "[") depth++;
    else if (t.text === ")" || t.text === "]") depth = Math.max(0, depth - 1);
    stmt.push(t);
  }
  const inRelationship = decl.kind === "relationship";

  // Innermost unclosed `(` or `[`.
  const stack: number[] = [];
  stmt.forEach((t, i) => {
    if (t.kind !== "punct") return;
    if (t.text === "(" || t.text === "[") stack.push(i);
    else if (t.text === ")" || t.text === "]") stack.pop();
  });
  const fieldTypeName = stmt[0]?.kind === "ident" ? stmt[1]?.text : undefined;
  if (stack.length) {
    const open = stack[stack.length - 1]!;
    const outerParen = stack.find((i) => stmt[i]!.text === "(");
    const callee = outerParen !== undefined ? stmt[outerParen - 1] : undefined;
    const sigil = outerParen !== undefined ? stmt[outerParen - 2] : undefined;
    if (!callee || callee.kind !== "ident" || (sigil?.kind !== "at" && sigil?.kind !== "atat")) {
      return [];
    }
    const model = sigil.kind === "atat";
    const dec = DECORATORS.find((d) => d.name === callee.text && (d.on === "model") === model);
    if (stmt[open]!.text === "[") {
      if (!model || callee.text !== "fulltext") return [];
      const listed = stmt
        .slice(open + 1)
        .filter((t) => t.kind === "ident")
        .map((t) => t.text);
      return scanFields(a.tokens, decl)
        .filter((f) => f.type === "String" && !listed.includes(f.name))
        .map((f) => ({
          label: f.name,
          kind: "field" as const,
          detail: f.list ? "String[]" : "String",
          replace,
        }));
    }
    // The current argument: tokens since the last `,` at this depth.
    let argStart = open + 1;
    let d = 0;
    for (let i = open + 1; i < stmt.length; i++) {
      const t = stmt[i]!;
      if (t.text === "(" || t.text === "[") d++;
      else if (t.text === ")" || t.text === "]") d--;
      else if (t.text === "," && d === 0) argStart = i + 1;
    }
    const arg = stmt.slice(argStart);
    if (dec?.name === "default" && !model) {
      return arg.length === 0 ? valueCompletions(ctx, dec, undefined, fieldTypeName) : [];
    }
    const colon = arg.findIndex((t) => t.text === ":");
    if (colon >= 0) {
      return arg.length === colon + 1
        ? valueCompletions(ctx, dec, arg[colon - 1]?.text, undefined)
        : [];
    }
    if (arg.length > 0) return [];
    const usedKeys = stmt
      .slice(open + 1)
      .filter((t, i, arr) => t.kind === "ident" && arr[i + 1]?.text === ":")
      .map((t) => t.text);
    return (dec?.args ?? [])
      .filter((x) => !usedKeys.includes(x.name))
      .map((x) => ({
        label: x.name,
        kind: "property" as const,
        documentation: x.doc,
        insertText: `${x.name}: `,
        replace,
      }));
  }

  const last = stmt[stmt.length - 1];
  if (last?.kind === "at") {
    const used = stmt.filter((_t, i) => stmt[i - 1]?.kind === "at").map((t) => t.text);
    return decoratorCompletions(ctx, fieldKind(a, fieldTypeName), inRelationship, false, used);
  }
  if (last?.kind === "atat") return inRelationship ? [] : attributeCompletions(ctx, false);
  if (stmt.length === 0) {
    if (inRelationship) {
      const present = new Set(
        a.tokens
          .slice(decl.open + 1, decl.close >= 0 ? decl.close : undefined)
          .filter((t, i, arr) => t.kind === "ident" && (i === 0 || arr[i - 1]!.kind === "newline"))
          .map((t) => t.text),
      );
      return [
        { label: "type", insertText: 'type "${1:TYPE}"', detail: "relationship type" },
        { label: "from", insertText: "from ${1:Node}", detail: "start node" },
        { label: "to", insertText: "to ${1:Node}", detail: "end node" },
      ]
        .filter((k) => !present.has(k.label))
        .map((k) => ({ ...k, kind: "keyword" as const, snippet: true, replace }));
    }
    return attributeCompletions(ctx, true).map((c) => ({ ...c, sortText: "9" }));
  }
  if (stmt.length === 1 && stmt[0]!.kind === "ident") {
    const head = stmt[0]!.text;
    if (inRelationship && (head === "from" || head === "to")) {
      return names(a, "node").map((n) => ({ label: n, kind: "node" as const, replace }));
    }
    if (inRelationship && head === "type") return [];
    return typeCompletions(ctx, !inRelationship);
  }
  if (
    stmt.length >= 2 &&
    stmt[0]!.kind === "ident" &&
    !["type", "from", "to"].includes(stmt[0]!.text)
  ) {
    const used = stmt.filter((_t, i) => stmt[i - 1]?.kind === "at").map((t) => t.text);
    return decoratorCompletions(ctx, fieldKind(a, fieldTypeName), inRelationship, true, used);
  }
  return [];
}

function topLevelCompletions(ctx: Ctx, before: readonly Token[]): Completion[] {
  // Only at the start of a line (not while naming a declaration).
  const prev = [...before].reverse().find((t) => t.kind !== "comment");
  if (prev && prev.kind !== "newline" && !(prev.kind === "punct" && prev.text === "}")) return [];
  const snippets: Record<string, string> = {
    node: "node ${1:Name} {\n\tid String @id @default(cuid())\n\t$0\n}",
    relationship:
      'relationship ${1:Name} {\n\ttype "${2:TYPE}"\n\tfrom ${3:Node}\n\tto ${4:Node}\n\t$0\n}',
    enum: "enum ${1:Name} {\n\t${2:VALUE}\n}",
  };
  return Object.entries(snippets).map(([k, snippet]) => ({
    label: k,
    kind: "keyword" as const,
    documentation: KEYWORD_DOCS[k],
    insertText: snippet,
    snippet: true,
    replace: ctx.replace,
  }));
}

/** Inside a string: analyzer names, relationship types already in use. */
function stringCompletions(
  a: Analysis,
  at: Token,
  offset: number,
  before: readonly Token[],
): Completion[] {
  const prev = before.filter(significant);
  if (prev[prev.length - 1]?.text !== ":") return [];
  const key = prev[prev.length - 2]?.text;
  const replace = { start: at.start + 1, end: at.unterminated ? offset : at.end - 1 };
  if (key === "analyzer") {
    const ft = DECORATORS.find((d) => d.name === "fulltext");
    return (ft?.args?.find((x) => x.name === "analyzer")?.values ?? []).map((v) => ({
      label: v,
      kind: "value" as const,
      replace,
    }));
  }
  if (key === "type") {
    return relationshipTypes(a).map((t) => ({ label: t, kind: "value" as const, replace }));
  }
  return [];
}
