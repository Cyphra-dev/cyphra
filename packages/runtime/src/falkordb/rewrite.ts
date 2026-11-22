/**
 * Neo4j Cypher → FalkorDB Cypher, for the statements the ORM (and the migrator) compile.
 *
 * FalkorDB runs openCypher with `CALL {}` subqueries but has no subquery *expressions* and no
 * element ids. The FalkorDB transport rewrites every statement before sending it:
 *
 * - `elementId(x) = $p` → `id(x) = toInteger($p)` (an id seek), any other `elementId(x)` →
 *   `toString(id(x))`: element ids are FalkorDB's integer ids as text.
 * - `EXISTS { MATCH … }`, `COUNT { MATCH … }` and `COLLECT { MATCH … RETURN x }` become `CALL {}`
 *   subqueries run just before the clause that uses them (`CALL { WITH * MATCH … RETURN
 *   collect(x) AS __cyphra_c0 }`), the expression reading the subquery's result instead. When the
 *   expression is in the `WHERE` of a `MATCH`, `WITH` or `YIELD`, the conjuncts that need it move
 *   to a `WITH * WHERE …` after the subqueries; the others stay where they are (index seeks keep
 *   working).
 *
 * - Vector values (arrays marked by `markVector`) → `vecf32(…)`, FalkorDB's vector type.
 * - `valueType(x)` → `typeOf(x)` (the type names differ: `Integer`, `String`, …).
 * - `(n:L $props)` / `[r:T $props]` → `(n:L {a: $props.a, …})`: FalkorDB takes no map parameter
 *   as the properties of a pattern.
 *
 * The rewrite works on tokens: string literals, backtick-quoted names and comments are never
 * changed. Statements without these constructs are returned unchanged.
 *
 * @packageDocumentation
 */

import { CyphraError } from "../orm/errors.js";
import { isVectorValue } from "../cypher-values.js";

type TokenKind = "word" | "quoted" | "string" | "param" | "punct" | "space" | "comment";
type Token = { kind: TokenKind; text: string };

/** Split Cypher text into tokens (whitespace and comments kept, so `join` restores the text). */
export function tokenize(text: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i]!;
    const start = i;
    if (/\s/.test(c)) {
      while (i < n && /\s/.test(text[i]!)) i++;
      out.push({ kind: "space", text: text.slice(start, i) });
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < n && text[i] !== "\n") i++;
      out.push({ kind: "comment", text: text.slice(start, i) });
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? n : end + 2;
      out.push({ kind: "comment", text: text.slice(start, i) });
    } else if (c === "'" || c === '"') {
      i++;
      while (i < n && text[i] !== c) i += text[i] === "\\" ? 2 : 1;
      i = Math.min(i + 1, n);
      out.push({ kind: "string", text: text.slice(start, i) });
    } else if (c === "`") {
      i++;
      for (;;) {
        while (i < n && text[i] !== "`") i++;
        if (text[i + 1] === "`") i += 2;
        else break;
      }
      i = Math.min(i + 1, n);
      out.push({ kind: "quoted", text: text.slice(start, i) });
    } else if (c === "$") {
      i++;
      if (text[i] === "`") {
        i++;
        while (i < n && text[i] !== "`") i++;
        i = Math.min(i + 1, n);
      } else {
        while (i < n && /[A-Za-z0-9_]/.test(text[i]!)) i++;
      }
      out.push({ kind: "param", text: text.slice(start, i) });
    } else if (/[A-Za-z0-9_]/.test(c)) {
      while (i < n && /[A-Za-z0-9_.]/.test(text[i]!)) {
        // Dotted names are one word (`db.idx.vector.queryNodes`, `n.prop`): a property named
        // like a keyword (`n.count`) is never mistaken for one.
        if (text[i] === "." && !/[A-Za-z_]/.test(text[i + 1] ?? "")) break;
        i++;
      }
      out.push({ kind: "word", text: text.slice(start, i) });
    } else {
      i++;
      out.push({ kind: "punct", text: c });
    }
  }
  return out;
}

const join = (tokens: readonly Token[]): string => tokens.map((t) => t.text).join("");

const isWord = (t: Token | undefined, ...words: string[]): boolean =>
  t?.kind === "word" && words.includes(t.text.toUpperCase());

/** Index of the next non-space, non-comment token at or after `i` (`tokens.length` if none). */
function next(tokens: readonly Token[], i: number): number {
  while (i < tokens.length && (tokens[i]!.kind === "space" || tokens[i]!.kind === "comment")) i++;
  return i;
}

/** Index of the previous significant token before `i` (`-1` if none). */
function prev(tokens: readonly Token[], i: number): number {
  i--;
  while (i >= 0 && (tokens[i]!.kind === "space" || tokens[i]!.kind === "comment")) i--;
  return i;
}

const OPEN: Record<string, string> = { "(": ")", "[": "]", "{": "}" };

/** Index of the bracket closing the one at `open`. */
function closing(tokens: readonly Token[], open: number): number {
  const stack: string[] = [];
  for (let i = open; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.kind !== "punct") continue;
    if (OPEN[t.text]) stack.push(OPEN[t.text]!);
    else if (t.text === ")" || t.text === "]" || t.text === "}") {
      if (stack.pop() !== t.text) break;
      if (stack.length === 0) return i;
    }
  }
  throw new CyphraError("FalkorDB rewrite: unbalanced brackets in the statement.");
}

// ---------------------------------------------------------------------------------------------
// elementId()

/** `elementId(x) = $p` → `id(x) = toInteger($p)`; `elementId(x)` → `toString(id(x))`. */
function rewriteElementIds(tokens: Token[]): Token[] {
  const out: Token[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    const open = next(tokens, i + 1);
    if (t.kind !== "word" || t.text.toLowerCase() !== "elementid" || tokens[open]?.text !== "(") {
      out.push(t);
      continue;
    }
    // A property or map key named `elementId` (`n.elementId`, `{elementId: …}`) is left alone.
    const before = tokens[prev(tokens, i)];
    if (before?.kind === "punct" && before.text === ".") {
      out.push(t);
      continue;
    }
    const close = closing(tokens, open);
    const inner = rewriteElementIds(tokens.slice(open + 1, close));
    const eq = next(tokens, close + 1);
    const param = next(tokens, eq + 1);
    if (
      tokens[eq]?.text === "=" &&
      tokens[eq]?.kind === "punct" &&
      tokens[param]?.kind === "param"
    ) {
      const after = tokens[next(tokens, param + 1)];
      // `= $p` exactly (not `= $p.x` / `= $p[0]`): an id seek.
      if (!(after?.kind === "punct" && (after.text === "." || after.text === "["))) {
        out.push(
          { kind: "word", text: "id" },
          { kind: "punct", text: "(" },
          ...inner,
          { kind: "punct", text: ")" },
          { kind: "space", text: " " },
          { kind: "punct", text: "=" },
          { kind: "space", text: " " },
          { kind: "word", text: "toInteger" },
          { kind: "punct", text: "(" },
          tokens[param]!,
          { kind: "punct", text: ")" },
        );
        i = param;
        continue;
      }
    }
    out.push(
      { kind: "word", text: "toString" },
      { kind: "punct", text: "(" },
      { kind: "word", text: "id" },
      { kind: "punct", text: "(" },
      ...inner,
      { kind: "punct", text: ")" },
      { kind: "punct", text: ")" },
    );
    i = close;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Subquery expressions

const SUBQUERY = ["EXISTS", "COUNT", "COLLECT"];

/** Words that start a clause (at depth 0 of a query). `SET` after `ON CREATE` / `ON MATCH` does not. */
const CLAUSE = new Set([
  "MATCH",
  "OPTIONAL",
  "WITH",
  "RETURN",
  "UNWIND",
  "CREATE",
  "MERGE",
  "SET",
  "DELETE",
  "DETACH",
  "REMOVE",
  "CALL",
  "FOREACH",
  "UNION",
  "LOAD",
]);

/** Clauses that write: a `CALL {}` cannot follow one directly. */
const UPDATING = new Set(["CREATE", "MERGE", "SET", "DELETE", "DETACH", "REMOVE", "FOREACH"]);

/** Words that end a `WHERE` expression (sub-clauses of `WITH` / `RETURN`). */
const AFTER_WHERE = new Set(["ORDER", "SKIP", "LIMIT"]);

type Clause = { start: number; end: number; keyword: string };

/** Whether the token at `i` is a subquery expression keyword followed by `{`. */
function isSubquery(tokens: readonly Token[], i: number): boolean {
  const t = tokens[i]!;
  if (t.kind !== "word" || !SUBQUERY.includes(t.text.toUpperCase())) return false;
  const brace = tokens[next(tokens, i + 1)];
  if (brace?.kind !== "punct" || brace.text !== "{") return false;
  // `n.count {` cannot occur; `count {` after `.` would be a property access.
  const before = tokens[prev(tokens, i)];
  return !(before?.kind === "punct" && before.text === ".");
}

/** Whether `tokens[from, to)` contains a subquery expression (at any depth). */
function hasSubquery(tokens: readonly Token[], from = 0, to = tokens.length): boolean {
  for (let i = from; i < to; i++) if (isSubquery(tokens, i)) return true;
  return false;
}

/** The clauses of one query part (depth-0 clause keywords of `tokens`). */
function clauses(tokens: readonly Token[]): Clause[] {
  const starts: { at: number; keyword: string }[] = [];
  let depth = 0;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.kind === "punct") {
      if (OPEN[t.text]) depth++;
      else if (t.text === ")" || t.text === "]" || t.text === "}") depth--;
      continue;
    }
    if (depth !== 0 || t.kind !== "word") continue;
    const word = t.text.toUpperCase();
    if (!CLAUSE.has(word)) continue;
    const p = tokens[prev(tokens, i)];
    // `OPTIONAL MATCH`, `DETACH DELETE`, `ON CREATE SET`, `ON MATCH SET`, `UNION ALL`: one clause.
    if (word === "MATCH" && isWord(p, "OPTIONAL")) continue;
    if (word === "DELETE" && isWord(p, "DETACH")) continue;
    if (word === "SET" && isWord(p, "CREATE", "MATCH")) {
      const pp = tokens[prev(tokens, prev(tokens, i))];
      if (isWord(pp, "ON")) continue;
    }
    if ((word === "CREATE" || word === "MATCH") && isWord(p, "ON")) continue;
    starts.push({ at: i, keyword: word });
  }
  return starts.map((s, k) => ({
    start: s.at,
    end: k + 1 < starts.length ? starts[k + 1]!.at : tokens.length,
    keyword: s.keyword,
  }));
}

/** Depth-0 index of the word `word` in `tokens[from, to)`, or `-1`. */
function findWord(tokens: readonly Token[], word: string, from: number, to: number): number {
  let depth = 0;
  for (let i = from; i < to; i++) {
    const t = tokens[i]!;
    if (t.kind === "punct") {
      if (OPEN[t.text]) depth++;
      else if (t.text === ")" || t.text === "]" || t.text === "}") depth--;
    } else if (depth === 0 && isWord(t, word)) return i;
  }
  return -1;
}

/** Split `tokens` at depth-0 `AND`s. */
function conjuncts(tokens: readonly Token[]): Token[][] {
  const parts: Token[][] = [[]];
  let depth = 0;
  for (const t of tokens) {
    if (t.kind === "punct") {
      if (OPEN[t.text]) depth++;
      else if (t.text === ")" || t.text === "]" || t.text === "}") depth--;
    }
    if (depth === 0 && isWord(t, "AND")) parts.push([]);
    else parts[parts.length - 1]!.push(t);
  }
  return parts.map(trim).filter((p) => p.length > 0);
}

/** Whether `tokens` is one parenthesized expression, `( … )`. */
function wrapped(tokens: readonly Token[]): boolean {
  const first = tokens[0];
  if (first?.kind !== "punct" || first.text !== "(") return false;
  return closing(tokens, 0) === tokens.length - 1;
}

function trim(tokens: Token[]): Token[] {
  let a = 0;
  let b = tokens.length;
  while (a < b && tokens[a]!.kind === "space") a++;
  while (b > a && tokens[b - 1]!.kind === "space") b--;
  return tokens.slice(a, b);
}

const sp: Token = { kind: "space", text: " " };
const w = (text: string): Token => ({ kind: "word", text });
const p = (text: string): Token => ({ kind: "punct", text });

class Rewriter {
  private count = 0;

  private fresh(kind: string): string {
    return `__cyphra_${kind}${this.count++}`;
  }

  /** Rewrite a whole query (or a `CALL {}` / subquery body), split at `UNION`. */
  query(tokens: Token[]): Token[] {
    if (!hasSubquery(tokens) && findWord(tokens, "CALL", 0, tokens.length) < 0) return tokens;
    const out: Token[] = [];
    let previous: string | undefined;
    for (const c of clauses(tokens)) {
      out.push(...this.clause(tokens.slice(c.start, c.end), c.keyword, previous));
      previous = c.keyword;
    }
    // Tokens before the first clause (leading space, `CYPHER` options, `EXPLAIN`, …).
    const first = clauses(tokens)[0]?.start ?? tokens.length;
    return [...tokens.slice(0, first), ...out];
  }

  /**
   * Hoist the subquery expressions of `expr` (outermost first) into `CALL {}`s appended to
   * `calls`; returns `expr` reading their results.
   */
  private hoist(expr: Token[], calls: Token[]): Token[] {
    const out: Token[] = [];
    for (let i = 0; i < expr.length; i++) {
      if (!isSubquery(expr, i)) {
        // A `CALL {` body inside the expression cannot occur; nested brackets are copied as is.
        out.push(expr[i]!);
        continue;
      }
      const kind = expr[i]!.text.toUpperCase();
      const open = next(expr, i + 1);
      const close = closing(expr, open);
      const body = trim(expr.slice(open + 1, close));
      const name = this.fresh(kind === "COLLECT" ? "c" : kind === "COUNT" ? "n" : "e");
      calls.push(...this.subquery(kind, body, name), sp);
      out.push(w(name));
      i = close;
    }
    return out;
  }

  /** `CALL { WITH * <body> RETURN … AS name }` for one subquery expression. */
  private subquery(kind: string, body: Token[], name: string): Token[] {
    // `EXISTS { (a)-->(b) }` (a bare pattern) is `EXISTS { MATCH (a)-->(b) }`.
    let tokens = body;
    const head = tokens[next(tokens, 0)];
    if (!(head?.kind === "word" && CLAUSE.has(head.text.toUpperCase()))) {
      tokens = [w("MATCH"), sp, ...tokens];
    }
    let tail: Token[];
    if (kind === "COLLECT") {
      const parts = clauses(tokens);
      const last = parts[parts.length - 1];
      if (!last || last.keyword !== "RETURN") {
        throw new CyphraError("FalkorDB rewrite: COLLECT {} must end with RETURN.");
      }
      const ret = tokens.slice(last.start, last.end);
      const r = next(ret, 1);
      let items = trim(ret.slice(r));
      let distinct = false;
      if (isWord(items[0], "DISTINCT")) {
        distinct = true;
        items = trim(items.slice(1));
      }
      if ([...AFTER_WHERE].some((k) => findWord(items, k, 0, items.length) >= 0)) {
        throw new CyphraError(
          "FalkorDB rewrite: COLLECT {} with ORDER BY / SKIP / LIMIT on RETURN.",
        );
      }
      const asAt = findWord(items, "AS", 0, items.length);
      const item = asAt >= 0 ? trim(items.slice(0, asAt)) : items;
      tokens = tokens.slice(0, last.start);
      tail = [
        w("RETURN"),
        sp,
        w("collect"),
        p("("),
        ...(distinct ? [w("DISTINCT"), sp] : []),
        ...item,
        p(")"),
        sp,
        w("AS"),
        sp,
        w(name),
      ];
    } else if (kind === "COUNT") {
      tail = [w("RETURN"), sp, w("count"), p("("), p("*"), p(")"), sp, w("AS"), sp, w(name)];
    } else {
      tail = [
        w("WITH"),
        sp,
        p("*"),
        sp,
        w("LIMIT"),
        sp,
        w("1"),
        sp,
        w("RETURN"),
        sp,
        w("count"),
        p("("),
        p("*"),
        p(")"),
        sp,
        p(">"),
        sp,
        w("0"),
        sp,
        w("AS"),
        sp,
        w(name),
      ];
    }
    const inner = this.query([...trim(tokens), sp, ...tail]);
    return [w("CALL"), sp, p("{"), sp, w("WITH"), sp, p("*"), sp, ...inner, sp, p("}")];
  }

  /** One clause, with the `CALL {}`s its subquery expressions need. */
  private clause(tokens: Token[], keyword: string, previous?: string): Token[] {
    // FalkorDB needs a `WITH` between an updating clause and a `CALL {}`.
    const bridge = previous && UPDATING.has(previous) ? [w("WITH"), sp, p("*"), sp] : [];
    // A `CALL { … }` subquery: rewrite its body.
    if (keyword === "CALL") {
      const brace = next(tokens, 1);
      if (tokens[brace]?.text === "{" && tokens[brace]?.kind === "punct") {
        const close = closing(tokens, brace);
        const body = this.query(tokens.slice(brace + 1, close));
        return [...tokens.slice(0, brace + 1), ...body, ...tokens.slice(close)];
      }
    }
    if (!hasSubquery(tokens)) return tokens;
    const whereAt = findWord(tokens, "WHERE", 0, tokens.length);
    const filtered =
      keyword === "MATCH" || keyword === "OPTIONAL" || keyword === "WITH" || keyword === "CALL";
    if (whereAt < 0 || !filtered) {
      const calls: Token[] = [];
      const body = this.hoist(tokens, calls);
      return [...(calls.length ? bridge : []), ...calls, ...body];
    }
    // The WHERE ends at ORDER BY / SKIP / LIMIT (a `WITH`'s sub-clauses), or with the clause.
    let whereEnd = tokens.length;
    for (const k of AFTER_WHERE) {
      const at = findWord(tokens, k, whereAt + 1, tokens.length);
      if (at >= 0 && at < whereEnd) whereEnd = at;
    }
    const headTokens = tokens.slice(0, whereAt);
    const where = tokens.slice(whereAt + 1, whereEnd);
    const rest = tokens.slice(whereEnd);
    const out: Token[] = [];
    // Subqueries in the projection (`WITH x, COUNT {…} AS c WHERE …`) run before the clause.
    const headCalls: Token[] = [];
    const headOut = this.hoist(headTokens, headCalls);
    const keep: Token[][] = [];
    const moved: Token[][] = [];
    for (const c of conjuncts(where)) (hasSubquery(c) ? moved : keep).push(c);
    if (moved.length && keyword === "OPTIONAL") {
      throw new CyphraError(
        "FalkorDB rewrite: a subquery expression in the WHERE of an OPTIONAL MATCH cannot be rewritten.",
      );
    }
    out.push(...(headCalls.length ? bridge : []), ...headCalls, ...trim(headOut));
    const and = (parts: Token[][]): Token[] =>
      parts.flatMap((c, k) => [
        ...(k ? [sp, w("AND"), sp] : []),
        ...(parts.length === 1 || wrapped(c) ? c : [p("("), ...c, p(")")]),
      ]);
    if (keep.length) out.push(sp, w("WHERE"), sp, ...and(keep));
    // ORDER BY / SKIP / LIMIT stay with their WITH, before the filter that moved after it.
    if (rest.length) {
      const restCalls: Token[] = [];
      const restOut = this.hoist(rest, restCalls);
      if (restCalls.length) {
        throw new CyphraError("FalkorDB rewrite: subquery expression after a WHERE.");
      }
      out.push(sp, ...trim(restOut));
    }
    const calls: Token[] = [];
    const filter = this.hoist(and(moved), calls);
    out.push(sp, ...calls, w("WITH"), sp, p("*"), sp, w("WHERE"), sp, ...filter, sp);
    return out;
  }
}

// ---------------------------------------------------------------------------------------------
// Property maps in patterns

function isPlainMap(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v) as unknown;
  return proto === Object.prototype || proto === null;
}

/** Whether `params` holds a vector value (at the top, in a map, or in a list of maps). */
function hasVectors(params: Record<string, unknown>): boolean {
  return Object.values(params).some(
    (v) =>
      isVectorValue(v) ||
      (isPlainMap(v) && vectorKeys([v]).length > 0) ||
      (Array.isArray(v) && vectorKeys(v).length > 0),
  );
}

const propName = (k: string): string =>
  /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) ? k : `\`${k.replace(/`/g, "``")}\``;

/**
 * `(n:L $p)` / `[r:T $p]` → `(n:L {a: $p.a, b: $p.b})`: FalkorDB takes no parameter as the
 * property map of a pattern. The keys come from the parameter's value.
 */
function expandPatternMaps(tokens: Token[], params: Record<string, unknown>): Token[] {
  const out: Token[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    const after = tokens[next(tokens, i + 1)];
    const label = tokens[prev(tokens, i)];
    const colon = tokens[prev(tokens, prev(tokens, i))];
    const value = t.kind === "param" ? params[t.text.slice(1).replace(/^`|`$/g, "")] : undefined;
    if (
      t.kind !== "param" ||
      !isPlainMap(value) ||
      after?.kind !== "punct" ||
      (after.text !== ")" && after.text !== "]") ||
      (label?.kind !== "word" && label?.kind !== "quoted") ||
      colon?.kind !== "punct" ||
      colon.text !== ":"
    ) {
      out.push(t);
      continue;
    }
    const entries = Object.keys(value)
      .filter((k) => value[k] !== undefined)
      .map((k) => {
        const ref = `${t.text}.${propName(k)}`;
        return `${propName(k)}: ${isVectorValue(value[k]) ? `vecf32(${ref})` : ref}`;
      });
    out.push({ kind: "word", text: `{${entries.join(", ")}}` });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Vectors

const paramName = (t: Token): string => t.text.slice(1).replace(/^`|`$/g, "");

/** Keys of `maps` holding a vector value (see `markVector`). */
function vectorKeys(maps: readonly unknown[]): string[] {
  const keys = new Set<string>();
  for (const m of maps) {
    if (!isPlainMap(m)) continue;
    for (const [k, v] of Object.entries(m)) if (isVectorValue(v)) keys.add(k);
  }
  return [...keys];
}

/**
 * Vector values as FalkorDB vectors: a vector parameter `$v` → `vecf32($v)`; `SET x = $map` /
 * `SET x += $map` gets `x.k = vecf32($map.k)` for each vector in the map; after
 * `UNWIND $rows AS row`, `SET x = row` gets `x.k = vecf32(row.k)`.
 */
function rewriteVectors(tokens: Token[], params: Record<string, unknown>): Token[] {
  const rows = new Map<string, string[]>(); // UNWIND alias → vector keys of its rows
  const out: Token[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (isWord(t, "UNWIND")) {
      const src = tokens[next(tokens, i + 1)];
      const as = next(tokens, next(tokens, i + 1) + 1);
      const alias = tokens[next(tokens, as + 1)];
      const value = src?.kind === "param" ? params[paramName(src)] : undefined;
      if (Array.isArray(value) && isWord(tokens[as], "AS") && alias?.kind === "word") {
        const keys = vectorKeys(value);
        if (keys.length) rows.set(alias.text, keys);
      }
    }
    if (t.kind === "param" && isVectorValue(params[paramName(t)])) {
      out.push({ kind: "word", text: "vecf32" }, { kind: "punct", text: "(" }, t, {
        kind: "punct",
        text: ")",
      });
      continue;
    }
    out.push(t);
    // `x = $map`, `x += $map`, `x = row` (an assignment of a whole map in a SET).
    if (t.kind !== "param" && t.kind !== "word") continue;
    const eq = prev(tokens, i);
    if (tokens[eq]?.kind !== "punct" || tokens[eq]!.text !== "=") continue;
    const plus = prev(tokens, eq);
    const target = tokens[tokens[plus]?.text === "+" ? prev(tokens, plus) : plus];
    if (target?.kind !== "word" || target.text.includes(".")) continue;
    const keys =
      t.kind === "param"
        ? isPlainMap(params[paramName(t)])
          ? vectorKeys([params[paramName(t)]])
          : []
        : (rows.get(t.text) ?? []);
    for (const k of keys) {
      out.push({
        kind: "word",
        text: `, ${target.text}.${propName(k)} = vecf32(${t.text}.${propName(k)})`,
      });
    }
  }
  return out;
}

/**
 * The relationship types `text` names in relationship patterns (`[r:A|B]`, `[:\`T\`*1..3]`), for
 * statements that may create relationships (`CREATE` / `MERGE`); `[]` for others.
 */
export function createdRelationshipTypes(text: string): string[] {
  if (!/\b(?:CREATE|MERGE)\b/i.test(text)) return [];
  const tokens = tokenize(text);
  const types = new Set<string>();
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i]!.kind !== "punct" || tokens[i]!.text !== "[") continue;
    let j = next(tokens, i + 1);
    if (tokens[j]?.kind === "word") j = next(tokens, j + 1); // the variable
    if (tokens[j]?.text !== ":") continue;
    for (;;) {
      const t = tokens[next(tokens, j + 1)];
      if (t?.kind === "word") types.add(t.text);
      else if (t?.kind === "quoted") types.add(t.text.slice(1, -1).replace(/``/g, "`"));
      else break;
      j = next(tokens, next(tokens, j + 1) + 1);
      if (tokens[j]?.text !== "|") break;
    }
  }
  return [...types];
}

/**
 * `text` in FalkorDB's Cypher (see the module comment), for `params` (property-map parameters of
 * patterns are expanded by key). Returns `text` itself when nothing needs rewriting.
 */
export function rewriteForFalkorDB(text: string, params: Record<string, unknown> = {}): string {
  const maps = Object.values(params).some(isPlainMap);
  const vectors = hasVectors(params);
  if (!maps && !vectors && !/elementId|EXISTS|COUNT|COLLECT|valueType/i.test(text)) return text;
  let tokens = tokenize(text);
  if (vectors) tokens = rewriteVectors(tokens, params);
  if (maps) tokens = expandPatternMaps(tokens, params);
  // `valueType()` (Neo4j 5.13+) has FalkorDB's `typeOf()` as its closest equivalent.
  tokens = tokens.map((t, i) =>
    t.kind === "word" && t.text === "valueType" && tokens[next(tokens, i + 1)]?.text === "("
      ? { kind: "word", text: "typeOf" }
      : t,
  );
  tokens = rewriteElementIds(tokens);
  if (hasSubquery(tokens)) tokens = new Rewriter().query(tokens);
  return join(tokens);
}
