/**
 * `@cypher` fields of node types as engine Cypher fragments (`cypher` fragments and `$call`
 * bodies, see `@cyphra/runtime`'s `cypherExpr.ts`), built so that they evaluate like the compat
 * compiler's statements (`cypher/custom.ts`):
 *
 * - the statement runs as `CALL (n) { WITH n AS this <statement> }`, its `columnName` column read
 *   from each row; `$jwt` is the decoded JWT (`{}` when not authenticated), each `$argument` the
 *   field argument (`NULL` when missing or null, an `Int` as an integer), both parameters;
 * - in projections and sorts, like the compiler, a field is a `CALL` clause (`$call`): a scalar
 *   field takes the column of each row (no row drops the node, several repeat it), a list field
 *   collects the values of every row, a field returning nodes the nodes of every row; sorts run
 *   before paging, projections after it, and a projection reuses the value of the sort on the same
 *   field (without arguments);
 * - filters compare the first row's value (`head(COLLECT { … })`, a list field every value), or
 *   test the nodes of the rows (a `$call` body in a `$cypherNodes` filter).
 *
 * The engine client reserves every name the statements use ({@link statementVariables}), so its
 * variables never clash with theirs (a subquery cannot shadow a variable).
 *
 * Neo4j 5 rejects aggregating functions (`count`, `collect`, …) inside a subquery expression of a
 * projection or of an `ORDER BY`: such statements carry the runtime's `CYPHER_AGGREGATES` mark, so
 * that the loads whose `where` contains them run as `CALL` clauses too. A connection's count or an
 * aggregate of nodes filtered by one cannot (it falls back).
 *
 * The response of a mutation is projected in the write statement, where `@cypher` fields stay
 * expressions (`expression*` functions): only statements returning exactly one row (a lone
 * `RETURN`), that neither aggregate nor name a variable of the write statement. Every other case
 * throws {@link Fallback}.
 *
 * @packageDocumentation
 */

import {
  CYPHER_AGGREGATES,
  CYPHER_NODE,
  cypherFragment,
  type CypherFragment,
} from "@cyphra/runtime";
import type { CypherAnnotation, FieldArgument, V7Model } from "../model.js";
import { q } from "../cypher/context.js";
import { Fallback } from "./where.js";

type AnyRecord = Record<string, unknown>;

/** What a statement's text tells about its rows. */
export type StatementShape = {
  /** It calls an aggregating function (`count(…)`, `collect(…)`, `apoc.agg.…(…)`, …). */
  readonly aggregates: boolean;
  /** It is a lone `RETURN` (no other clause): exactly one row. */
  readonly oneRow: boolean;
  /**
   * It names a variable an engine write statement may use (`n`, `row`, a name ending with digits,
   * …): Neo4j rejects a variable of a subquery that shadows one of the enclosing query. (Reads
   * reserve the statements' names, see {@link statementVariables}.)
   */
  readonly clashes: boolean;
};

/** Variables of engine write statements (`n`, `row`, `m0`, `r1`, …). */
const ENGINE_VARIABLE = /^(?:n|row|node|score|hit|cyphra_value_|[A-Za-z_]+\d+)$/;

const AGGREGATING =
  /\b(?:count|collect|sum|avg|min|max|stdev|stdevp|percentilecont|percentiledisc)\s*\(|\bagg\.|\.agg\b/i;

/** Clause keywords: a lone `RETURN` has none of them outside its subqueries. */
const CLAUSES = new Set([
  "MATCH",
  "OPTIONAL",
  "WITH",
  "UNWIND",
  "CALL",
  "UNION",
  "WHERE",
  "ORDER",
  "SKIP",
  "OFFSET",
  "LIMIT",
  "CREATE",
  "MERGE",
  "SET",
  "DELETE",
  "DETACH",
  "REMOVE",
  "FOREACH",
  "LOAD",
  "USE",
  "FINISH",
  "YIELD",
  "RETURN",
  "FILTER",
  "LET",
  "NEXT",
  "INSERT",
]);

/**
 * The statement without comments and literals (strings and quoted names become `_`), to look at
 * its keywords and calls.
 */
function code(statement: string): string {
  let out = "";
  for (let i = 0; i < statement.length;) {
    const c = statement[i]!;
    const next = statement[i + 1];
    if (c === "/" && next === "/") {
      const end = statement.indexOf("\n", i);
      i = end < 0 ? statement.length : end;
      out += " ";
    } else if (c === "/" && next === "*") {
      const end = statement.indexOf("*/", i + 2);
      i = end < 0 ? statement.length : end + 2;
      out += " ";
    } else if (c === "'" || c === '"' || c === "`") {
      let j = i + 1;
      while (j < statement.length && statement[j] !== c) j += statement[j] === "\\" ? 2 : 1;
      i = j + 1;
      out += "_";
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** See {@link StatementShape}. */
export function statementShape(statement: string): StatementShape {
  const text = code(statement);
  const aggregates = AGGREGATING.test(text);
  // Words outside brackets, not after `.` / `$` (property keys, parameters).
  const words: string[] = [];
  let depth = 0;
  const re = /[A-Za-z_][A-Za-z_0-9]*|[()[\]{}]|./gs;
  let prev = "";
  let clashes = false;
  for (const m of text.matchAll(re)) {
    const t = m[0];
    if (t === "(" || t === "[" || t === "{") depth++;
    else if (t === ")" || t === "]" || t === "}") depth--;
    else if (/^[A-Za-z_]/.test(t) && prev !== "." && prev !== "$") {
      if (depth === 0) words.push(t.toUpperCase());
      if (ENGINE_VARIABLE.test(t)) clashes = true;
    }
    if (t.trim()) prev = t;
  }
  const clauses = words.filter((w) => CLAUSES.has(w));
  const oneRow = clauses.length === 1 && clauses[0] === "RETURN" && words[0] === "RETURN";
  return { aggregates, oneRow, clashes };
}

/**
 * Every name the `@cypher` statements of `model` use (words outside literals and comments): the
 * engine client never gives a variable one of them.
 */
export function statementVariables(model: V7Model): Set<string> {
  const statements: string[] = [];
  for (const node of model.nodes) {
    for (const a of node.attributes) if (a.cypher) statements.push(a.cypher.statement);
    for (const c of node.cypherNodes) statements.push(c.cypher.statement);
  }
  for (const props of model.properties.values()) {
    for (const a of props.attributes) if (a.cypher) statements.push(a.cypher.statement);
  }
  for (const f of [...model.query.fields, ...model.mutation.fields]) {
    statements.push(f.cypher.statement);
  }
  const names = new Set<string>();
  for (const st of statements) {
    for (const m of code(st).matchAll(/[A-Za-z_][A-Za-z_0-9]*/g)) names.add(m[0]);
  }
  return names;
}

function count$(text: string): number {
  return text.split("$").length - 1;
}

/** An argument value as the compiler binds it: `Int` values as integers, `null` when missing. */
function argumentValue(arg: FieldArgument, value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((v) => argumentValue(arg, v));
  if (arg.kind === "scalar" && arg.type.name === "Int") {
    if (typeof value !== "number" || !Number.isSafeInteger(value)) {
      throw new Fallback("@cypher Int argument");
    }
    return BigInt(value);
  }
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  throw new Fallback(`@cypher ${arg.type.name} argument`);
}

/** Literal text and values of a fragment, joined into a {@link CypherFragment}. */
function fragment(
  parts: readonly (string | { value: unknown } | typeof CYPHER_NODE)[],
): CypherFragment {
  const strings: string[] = [""];
  const values: unknown[] = [];
  for (const p of parts) {
    if (typeof p === "string") strings[strings.length - 1] += p;
    else {
      values.push(p === CYPHER_NODE ? CYPHER_NODE : (p as { value: unknown }).value);
      strings.push("");
    }
  }
  return cypherFragment(strings as unknown as TemplateStringsArray, ...values);
}

/**
 * `CALL (n) { WITH n AS this <statement> }` with `$jwt` and the arguments bound (v7
 * `replaceArgumentsInStatement`), as fragment parts. A statement using another parameter falls back
 * (`context.cypherParams` requests already run on the compiler).
 */
function statementCall(
  cypher: CypherAnnotation,
  args: readonly FieldArgument[],
  values: AnyRecord,
  jwt: unknown,
  /** A root field's statement: `CALL () { <statement> }`. */
  root = false,
): (string | { value: unknown } | typeof CYPHER_NODE)[] {
  // v7 rewrites `$name` anywhere in the text: in a string literal or a comment too.
  if (count$(code(cypher.statement)) !== count$(cypher.statement)) {
    throw new Fallback("@cypher statement with $ in a literal or a comment");
  }
  const names = new Map(args.map((a) => [a.name.replace(/[^_A-Za-z0-9]/g, ""), a]));
  const bound = new Map<string, { value: unknown }>();
  const body: (string | { value: unknown })[] = [];
  let last = 0;
  // Arguments first (v7 binds them before `$jwt`), each value bound once.
  const re = /\$([A-Za-z_][A-Za-z_0-9]*)\b/g;
  for (const m of cypher.statement.matchAll(re)) {
    const name = m[1]!;
    const arg = names.get(name);
    let replacement: string | { value: unknown };
    if (arg) {
      const value = values[arg.name];
      if (value === null || value === undefined) replacement = "NULL";
      else {
        let b = bound.get(name);
        if (!b) {
          b = { value: argumentValue(arg, value) };
          bound.set(name, b);
        }
        replacement = b;
      }
    } else if (name === "jwt") {
      replacement = { value: jwt };
    } else {
      throw new Fallback(`@cypher statement parameter $${name}`);
    }
    body.push(cypher.statement.slice(last, m.index), replacement);
    last = m.index + m[0].length;
  }
  body.push(cypher.statement.slice(last));
  // Loads whose `where` contains an aggregating statement run as `CALL` clauses (the runtime
  // looks for the mark).
  const mark = statementShape(cypher.statement).aggregates ? `${CYPHER_AGGREGATES}\n` : "";
  if (root) return [`${mark}CALL () {\n  `, ...body, "\n}"];
  return [
    `${mark}CALL (`,
    CYPHER_NODE,
    ") {\n  WITH ",
    CYPHER_NODE,
    " AS this\n  ",
    ...body,
    "\n}",
  ];
}

/** A statement used as an expression of a write's projection (see the module comment). */
function expressionOnly(cypher: CypherAnnotation): void {
  const shape = statementShape(cypher.statement);
  if (shape.clashes) {
    throw new Fallback("@cypher statement variable that may shadow the engine's, in a mutation");
  }
  if (shape.aggregates) throw new Fallback("@cypher statement that aggregates, in a mutation");
}

/** `$call` body of a scalar field: the column of each row. */
export function scalarCall(
  cypher: CypherAnnotation,
  args: readonly FieldArgument[],
  values: AnyRecord,
  jwt: unknown,
): CypherFragment {
  return fragment([
    ...statementCall(cypher, args, values, jwt),
    `\nRETURN ${q(cypher.columnName)}`,
  ]);
}

/** `$call` body of a list field: one row, every value of every row (a list column flattened). */
export function listCall(
  cypher: CypherAnnotation,
  args: readonly FieldArgument[],
  values: AnyRecord,
  jwt: unknown,
): CypherFragment {
  return fragment([
    ...statementCall(cypher, args, values, jwt),
    `\nUNWIND ${q(cypher.columnName)} AS cyphra_value_\nRETURN collect(cyphra_value_)`,
  ]);
}

/** `$call` body of a field returning nodes: the column of each row. */
export const nodesCall = scalarCall;

/** A scalar field in a mutation's projection (a lone `RETURN`: exactly one row). */
export function expressionValue(
  cypher: CypherAnnotation,
  args: readonly FieldArgument[],
  values: AnyRecord,
  jwt: unknown,
): CypherFragment {
  expressionOnly(cypher);
  if (!statementShape(cypher.statement).oneRow) {
    throw new Fallback(
      "@cypher scalar whose statement may not return exactly one row, in a mutation",
    );
  }
  return fragment([
    "head(COLLECT {\n",
    ...statementCall(cypher, args, values, jwt),
    `\nRETURN ${q(cypher.columnName)}\n})`,
  ]);
}

/** A list field in a mutation's projection: every non-null value of every row, flattened. */
export function expressionList(
  cypher: CypherAnnotation,
  args: readonly FieldArgument[],
  values: AnyRecord,
  jwt: unknown,
): CypherFragment {
  expressionOnly(cypher);
  return fragment([
    "COLLECT {\n",
    ...statementCall(cypher, args, values, jwt),
    `\nUNWIND ${q(cypher.columnName)} AS cyphra_value_\nWITH cyphra_value_ WHERE cyphra_value_ IS NOT NULL\nRETURN cyphra_value_\n}`,
  ]);
}

/** The nodes of a field returning nodes, in a mutation's projection. */
export function expressionNodes(
  cypher: CypherAnnotation,
  args: readonly FieldArgument[],
  values: AnyRecord,
  jwt: unknown,
): CypherFragment {
  expressionOnly(cypher);
  return fragment([
    "COLLECT {\n",
    ...statementCall(cypher, args, values, jwt),
    `\nRETURN ${q(cypher.columnName)}\n}`,
  ]);
}

/** The value of a field in a filter: the first row's value, or every value of a list field. */
export function filterValue(cypher: CypherAnnotation, list: boolean, jwt: unknown): CypherFragment {
  const call = statementCall(cypher, [], {}, jwt);
  if (!list) return fragment(["head(COLLECT {\n", ...call, `\nRETURN ${q(cypher.columnName)}\n})`]);
  return fragment([
    "COLLECT {\n",
    ...call,
    `\nUNWIND ${q(cypher.columnName)} AS cyphra_value_\nRETURN cyphra_value_\n}`,
  ]);
}

/** The nodes of a field returning nodes, in a filter: a `$call` body (the column of every row). */
export function filterNodes(cypher: CypherAnnotation, jwt: unknown): CypherFragment {
  return scalarCall(cypher, [], {}, jwt);
}

/**
 * A `Query` / `Mutation` field's statement (`CALL () { <statement> }`) as a whole statement for
 * `runCypherFragment`: the `value` column of each row (a list column flattened, like v7).
 */
export function rootScalarStatement(
  cypher: CypherAnnotation,
  args: readonly FieldArgument[],
  values: AnyRecord,
  jwt: unknown,
  list: boolean,
): CypherFragment {
  const col = q(cypher.columnName);
  return fragment([
    ...statementCall(cypher, args, values, jwt, true),
    list
      ? `\nUNWIND ${col} AS cyphra_value_\nRETURN cyphra_value_ AS value`
      : `\nRETURN ${col} AS value`,
  ]);
}

/** A `Query` / `Mutation` field returning nodes: the `$from` body of the nodes of its rows. */
export function rootNodesCall(
  cypher: CypherAnnotation,
  args: readonly FieldArgument[],
  values: AnyRecord,
  jwt: unknown,
): CypherFragment {
  return fragment([
    ...statementCall(cypher, args, values, jwt, true),
    `\nRETURN ${q(cypher.columnName)}`,
  ]);
}
