/**
 * `@cypher` fields of node types as engine Cypher expressions (`cypher` fragments, see
 * `@cyphra/runtime`'s `cypherExpr.ts`), built so that they evaluate like the compat compiler's
 * statements (`cypher/custom.ts`):
 *
 * - the statement runs as `CALL (n) { WITH n AS this <statement> }`, its `columnName` column read
 *   from each row; `$jwt` is the decoded JWT (`{}` when not authenticated), each `$argument` the
 *   field argument (`NULL` when missing or null, an `Int` as an integer), both parameters;
 * - filters compare the first row's value (`head(COLLECT { … })`, a list field every value);
 * - a scalar field's value in a projection or a sort is the column of each row: a statement may
 *   return no row (v7 then drops the node) or several (v7 repeats it), so only statements that
 *   always return exactly one row (a lone `RETURN`) are expressions; a list field collects its
 *   values (one row whatever the statement returns);
 * - a field returning nodes collects the rows' nodes.
 *
 * Neo4j 5 rejects a statement that aggregates (`count`, `collect`, …) inside a subquery expression
 * of a projection or of an `ORDER BY` (the compiler hoists those into `CALL` clauses), and the
 * engine projects in map projections: such statements only appear in the `where` of a root read.
 * Every other case throws {@link Fallback}.
 *
 * @packageDocumentation
 */

import { CYPHER_NODE, cypherFragment, type CypherFragment } from "@cyphra/runtime";
import type { CypherAnnotation, FieldArgument } from "../model.js";
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
   * It names a variable the engine may use in the same statement (`n`, `node`, `score`, a name
   * ending with digits, …). Neo4j rejects a variable of a subquery expression that shadows one of
   * the enclosing query.
   */
  readonly clashes: boolean;
};

/** Variables of engine statements (`n`, `m0`, `r1`, …, and the search's `node` / `score`). */
const ENGINE_VARIABLE = /^(?:n|node|score|hit|cyphra_value_|[A-Za-z_]+\d+)$/;

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
  return ["CALL (", CYPHER_NODE, ") {\n  WITH ", CYPHER_NODE, " AS this\n  ", ...body, "\n}"];
}

/** The statement of a `@cypher` field, checked for where it is used (see the module comment). */
function checked(
  cypher: CypherAnnotation,
  use: "value" | "list" | "nodes" | "filter",
  root: boolean,
): void {
  const shape = statementShape(cypher.statement);
  if (shape.clashes) throw new Fallback("@cypher statement variable that may shadow the engine's");
  if (shape.aggregates && !(use === "filter" && root)) {
    throw new Fallback(
      "@cypher statement that aggregates, in a projection, a sort or a nested filter",
    );
  }
  if (use === "value" && !shape.oneRow) {
    throw new Fallback("@cypher scalar whose statement may not return exactly one row");
  }
}

/** The value of a scalar field in a projection or a sort (a lone `RETURN`: exactly one row). */
export function scalarValue(
  cypher: CypherAnnotation,
  args: readonly FieldArgument[],
  values: AnyRecord,
  jwt: unknown,
): CypherFragment {
  checked(cypher, "value", false);
  return fragment([
    "head(COLLECT {\n",
    ...statementCall(cypher, args, values, jwt),
    `\nRETURN ${q(cypher.columnName)}\n})`,
  ]);
}

/** The value of a list field in a projection: every non-null value of every row, flattened. */
export function listValue(
  cypher: CypherAnnotation,
  args: readonly FieldArgument[],
  values: AnyRecord,
  jwt: unknown,
): CypherFragment {
  checked(cypher, "list", false);
  return fragment([
    "COLLECT {\n",
    ...statementCall(cypher, args, values, jwt),
    `\nUNWIND ${q(cypher.columnName)} AS cyphra_value_\nWITH cyphra_value_ WHERE cyphra_value_ IS NOT NULL\nRETURN cyphra_value_\n}`,
  ]);
}

/** The value of a field in a filter: the first row's value, or every value of a list field. */
export function filterValue(
  cypher: CypherAnnotation,
  list: boolean,
  jwt: unknown,
  root: boolean,
): CypherFragment {
  checked(cypher, "filter", root);
  const call = statementCall(cypher, [], {}, jwt);
  if (!list) return fragment(["head(COLLECT {\n", ...call, `\nRETURN ${q(cypher.columnName)}\n})`]);
  return fragment([
    "COLLECT {\n",
    ...call,
    `\nUNWIND ${q(cypher.columnName)} AS cyphra_value_\nRETURN cyphra_value_\n}`,
  ]);
}

/** The nodes of a field returning nodes: the column of every row. */
export function nodesValue(
  cypher: CypherAnnotation,
  args: readonly FieldArgument[],
  values: AnyRecord,
  jwt: unknown,
): CypherFragment {
  checked(cypher, "nodes", false);
  return fragment([
    "COLLECT {\n",
    ...statementCall(cypher, args, values, jwt),
    `\nRETURN ${q(cypher.columnName)}\n}`,
  ]);
}

/** The nodes of a field returning nodes, in a filter (the column of every row). */
export function filterNodes(cypher: CypherAnnotation, jwt: unknown, root: boolean): CypherFragment {
  checked(cypher, "filter", root);
  return fragment([
    "COLLECT {\n",
    ...statementCall(cypher, [], {}, jwt),
    `\nRETURN ${q(cypher.columnName)}\n}`,
  ]);
}
