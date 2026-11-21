/**
 * A tolerant tokenizer for `.cyphra` text. Unlike the parser it never fails, so completion and the
 * outline keep working while a schema is half typed.
 */

export type TokenKind =
  "ident" | "string" | "number" | "comment" | "newline" | "at" | "atat" | "punct" | "unknown";

export type Token = {
  readonly kind: TokenKind;
  readonly text: string;
  /** Offset of the first character. */
  readonly start: number;
  /** Offset after the last character. */
  readonly end: number;
  /** A string literal without its closing quote (still being typed). */
  readonly unterminated?: boolean;
};

const IDENT_START = /[A-Za-z_]/;
const IDENT_PART = /[A-Za-z0-9_]/;

/** Split text into tokens (whitespace other than newlines is dropped). */
export function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    const start = i;
    if (ch === "\n") {
      tokens.push({ kind: "newline", text: "\n", start, end: ++i });
    } else if (ch === " " || ch === "\t" || ch === "\r") {
      i++;
    } else if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n" && text[i] !== "\r") i++;
      tokens.push({ kind: "comment", text: text.slice(start, i), start, end: i });
    } else if (ch === '"') {
      i++;
      let closed = false;
      while (i < text.length && text[i] !== "\n") {
        if (text[i] === "\\") i += 2;
        else if (text[i] === '"') {
          i++;
          closed = true;
          break;
        } else i++;
      }
      i = Math.min(i, text.length);
      tokens.push({
        kind: "string",
        text: text.slice(start, i),
        start,
        end: i,
        ...(closed ? {} : { unterminated: true }),
      });
    } else if (IDENT_START.test(ch)) {
      while (i < text.length && IDENT_PART.test(text[i]!)) i++;
      tokens.push({ kind: "ident", text: text.slice(start, i), start, end: i });
    } else if (/[0-9-]/.test(ch) && (ch !== "-" || /[0-9]/.test(text[i + 1] ?? ""))) {
      i++;
      while (i < text.length && /[0-9.]/.test(text[i]!)) i++;
      tokens.push({ kind: "number", text: text.slice(start, i), start, end: i });
    } else if (ch === "@") {
      const double = text[i + 1] === "@";
      i += double ? 2 : 1;
      tokens.push({ kind: double ? "atat" : "at", text: double ? "@@" : "@", start, end: i });
    } else if ("{}()[]:,?".includes(ch)) {
      tokens.push({ kind: "punct", text: ch, start, end: ++i });
    } else {
      tokens.push({ kind: "unknown", text: ch, start, end: ++i });
    }
  }
  return tokens;
}

/** A `node` / `interface` / `relationship` / `enum` block found by {@link scanDeclarations}. */
export type ScannedDeclaration = {
  readonly kind: "node" | "interface" | "relationship" | "enum";
  readonly name: string;
  readonly keyword: Token;
  readonly nameToken: Token;
  /** Interface names after `implements` (`node X implements A, B { … }`), possibly empty. */
  readonly implements: readonly Token[];
  /** Index of the `{` token (or -1 when not typed yet). */
  readonly open: number;
  /** Index of the matching `}` token (or -1 when not closed). */
  readonly close: number;
  /** Offset where the declaration ends (its `}`, or the next declaration / end of text). */
  readonly end: number;
};

/** Scalar or relation-looking field lines of a block: `name Type …`. */
export type ScannedField = {
  readonly name: string;
  readonly nameToken: Token;
  /** Type name without `?` / `[]` / `(N)` (absent while not typed yet). */
  readonly type?: string;
  readonly list: boolean;
};

const DECL_KEYWORDS = new Set(["node", "interface", "relationship", "enum"]);

/**
 * Skip an `implements A, B` clause starting at `from` (the token after a declaration's name):
 * returns the interface name tokens and the index of the first token after the clause.
 */
export function scanImplements(
  tokens: readonly Token[],
  from: number,
): { names: Token[]; next: number } {
  const names: Token[] = [];
  const kw = nextSignificant(tokens, from);
  if (!kw || kw.token.kind !== "ident" || kw.token.text !== "implements") {
    return { names, next: from };
  }
  let i = kw.index + 1;
  for (;;) {
    const n = nextSignificant(tokens, i);
    if (!n || n.token.kind !== "ident") return { names, next: i };
    names.push(n.token);
    i = n.index + 1;
    const comma = nextSignificant(tokens, i);
    if (!comma || comma.token.text !== ",") return { names, next: i };
    i = comma.index + 1;
  }
}

/** Find top-level declarations, tolerating unclosed blocks. */
export function scanDeclarations(tokens: readonly Token[]): ScannedDeclaration[] {
  const out: ScannedDeclaration[] = [];
  let depth = 0;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.kind === "punct" && t.text === "{") depth++;
    else if (t.kind === "punct" && t.text === "}") depth = Math.max(0, depth - 1);
    // A keyword at the start of a line also starts a declaration inside an unclosed block.
    const atLineStart = i === 0 || tokens[i - 1]!.kind === "newline";
    if (t.kind !== "ident" || !DECL_KEYWORDS.has(t.text) || (depth > 0 && !atLineStart)) continue;
    const nameToken = tokens[i + 1];
    if (!nameToken || nameToken.kind !== "ident") continue;
    const header = scanImplements(tokens, i + 2);
    if (depth > 0) {
      // Only when followed by `{` on the same line (`node X {`), so a field named `node` is safe.
      const next = nextSignificant(tokens, header.next);
      if (!next || next.token.text !== "{") continue;
      depth = 0;
    }
    let open = -1;
    let close = -1;
    let j = header.next;
    const next = nextSignificant(tokens, j);
    if (next && next.token.text === "{") {
      open = next.index;
      let d = 0;
      for (j = open; j < tokens.length; j++) {
        const u = tokens[j]!;
        if (u.text === "{" && u.kind === "punct") d++;
        else if (u.text === "}" && u.kind === "punct") {
          d--;
          if (d === 0) {
            close = j;
            break;
          }
        } else if (
          u.kind === "ident" &&
          DECL_KEYWORDS.has(u.text) &&
          tokens[j - 1]?.kind === "newline" &&
          tokens[j + 1]?.kind === "ident" &&
          nextSignificant(tokens, scanImplements(tokens, j + 2).next)?.token.text === "{"
        ) {
          break;
        }
      }
    }
    const lastHeader = header.names[header.names.length - 1] ?? nameToken;
    const end =
      close >= 0
        ? tokens[close]!.end
        : open >= 0
          ? (tokens[j - 1]?.end ?? nameToken.end)
          : lastHeader.end;
    out.push({
      kind: t.text as ScannedDeclaration["kind"],
      name: nameToken.text,
      keyword: t,
      nameToken,
      implements: header.names,
      open,
      close,
      end,
    });
    if (close >= 0) {
      i = close;
      depth = 0;
    } else if (open >= 0) {
      i = j - 1;
      depth = 0;
    }
  }
  return out;
}

/** The next token that is not a comment or newline. */
export function nextSignificant(
  tokens: readonly Token[],
  from: number,
): { token: Token; index: number } | undefined {
  for (let i = from; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.kind !== "comment" && t.kind !== "newline") return { token: t, index: i };
  }
  return undefined;
}

/** Field lines (`name Type …`) of a scanned node or relationship block. */
export function scanFields(tokens: readonly Token[], decl: ScannedDeclaration): ScannedField[] {
  if (decl.open < 0) return [];
  const out: ScannedField[] = [];
  const last = decl.close >= 0 ? decl.close : tokens.length;
  let lineStart = true;
  let parens = 0;
  for (let i = decl.open + 1; i < last; i++) {
    const t = tokens[i]!;
    if (t.kind === "newline") {
      if (parens === 0) lineStart = true;
      continue;
    }
    if (t.kind === "comment") continue;
    if (t.text === "(" || t.text === "[") parens++;
    else if (t.text === ")" || t.text === "]") parens = Math.max(0, parens - 1);
    if (!lineStart) continue;
    lineStart = false;
    if (t.kind !== "ident" || ["type", "from", "to"].includes(t.text)) continue;
    const typeTok = tokens[i + 1];
    const type = typeTok?.kind === "ident" ? typeTok.text : undefined;
    const after = tokens[i + 2];
    out.push({
      name: t.text,
      nameToken: t,
      ...(type ? { type } : {}),
      list: after?.text === "[" && tokens[i + 3]?.text === "]",
    });
  }
  return out;
}
