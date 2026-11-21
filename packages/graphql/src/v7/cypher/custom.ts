/**
 * `@cypher` statements: binding of the field arguments, `this`, `$jwt`, and the subqueries that run
 * them.
 *
 * Semantics follow `@neo4j/graphql` 7.6:
 * - the statement runs in a subquery where `this` is the node (or relationship) the field belongs
 *   to: `CALL (v) { WITH v AS this <statement> }`; root fields run it on their own;
 * - `$name` references to the field arguments are rewritten to fresh parameters (`NULL` when the
 *   argument is missing or null), like v7's `replaceArgumentsInStatement`: values are never put in
 *   the statement text; other `$name` references are left as they are (`$jwt` is the decoded JWT,
 *   `{}` when the request is not authenticated, and `context.cypherParams` are passed as top-level
 *   parameters);
 * - in projections and sorts, a scalar field takes the `columnName` column of each row: like v7, a
 *   statement returning no row removes the node from the result, several rows repeat it; a list
 *   field collects the values of every row (a list column is flattened);
 * - in filters, a scalar field compares the first row's value (`null` without rows).
 *
 * Neo4j 5 rejects an aggregating statement (`count`, `collect`, …) inside a subquery expression of a
 * projection (`RETURN n { c: COLLECT { CALL … count(…) … } }` fails with "implicit grouping
 * expressions"), so statements only appear in `WHERE` predicates or as `CALL` clauses: every
 * subquery expression that contains one is hoisted into a `CALL (*) { … }` clause of the enclosing
 * query (see {@link hasStatement}).
 *
 * @packageDocumentation
 */

import neo4j from "neo4j-driver";
import type { CypherAnnotation, FieldArgument } from "../model.js";
import { q, type CypherContext } from "./context.js";

type AnyRecord = Record<string, unknown>;

/** Comment written before every user statement, so the text of a subquery tells it contains one. */
export const STATEMENT_MARK = "/* @cypher */";

export function hasStatement(...texts: readonly (string | undefined)[]): boolean {
  return texts.some((t) => t !== undefined && t.includes(STATEMENT_MARK));
}

/** An argument value as a parameter: `Int` values become driver integers (as v7 sends them). */
function argumentValue(arg: FieldArgument, value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((v) => argumentValue(arg, v));
  if (arg.kind === "scalar" && arg.type.name === "Int" && typeof value === "number") {
    return neo4j.int(value);
  }
  return value;
}

/**
 * The statement with `$arg` references replaced by parameters (v7 `replaceArgumentsInStatement`):
 * a missing or null argument becomes `NULL`, the same value bound twice uses one parameter.
 */
export function bindArguments(
  ctx: CypherContext,
  statement: string,
  args: readonly FieldArgument[],
  values: AnyRecord,
): string {
  if (args.length === 0) return statement;
  const names = args.map((a) => a.name.replace(/[^_A-Za-z0-9]/g, ""));
  const re = new RegExp(`\\$(${names.join("|")})\\b`, "g");
  const bound = new Map<string, string>();
  return statement.replace(re, (_m, name: string) => {
    const value = values[name];
    if (value === undefined || value === null) return "NULL";
    let p = bound.get(name);
    if (!p) {
      p = ctx.param(
        argumentValue(
          args.find((a) => a.name === name)!,
          value,
        ),
      );
      bound.set(name, p);
    }
    return p;
  });
}

/**
 * `CALL (v) { WITH v AS this <statement> }`, or `CALL () { <statement> }` for a root field: the
 * statement's columns are in scope after it.
 */
export function statementCall(
  ctx: CypherContext,
  cypher: CypherAnnotation,
  args: readonly FieldArgument[],
  values: AnyRecord,
  variable?: string,
): string {
  const statement = bindArguments(ctx, cypher.statement, args, values);
  if (/\$jwt\b/.test(statement)) ctx.namedParam("jwt", ctx.jwt);
  if (variable === undefined) return `CALL () {\n  ${STATEMENT_MARK}\n  ${statement}\n}`;
  return `CALL (${variable}) {\n  WITH ${variable} AS this\n  ${STATEMENT_MARK}\n  ${statement}\n}`;
}

/** The `columnName` column of a statement. */
export function column(cypher: CypherAnnotation): string {
  return q(cypher.columnName);
}

/**
 * The value of a scalar `@cypher` field of `variable` as a clause binding a fresh variable:
 * `CALL (v) { <statement> RETURN col AS s }` (one row per statement row), or for a list field
 * `CALL (v) { <statement> UNWIND col AS x RETURN collect(x) AS s }` (always one row).
 */
export function scalarClause(
  ctx: CypherContext,
  variable: string,
  cypher: CypherAnnotation,
  args: readonly FieldArgument[],
  values: AnyRecord,
  list: boolean,
): { clause: string; variable: string } {
  const s = ctx.variable("cypher");
  const call = statementCall(ctx, cypher, args, values, variable);
  if (!list) {
    return {
      clause: `CALL (${variable}) {\n${call}\nRETURN ${column(cypher)} AS ${s}\n}`,
      variable: s,
    };
  }
  const x = ctx.variable("value");
  return {
    clause: `CALL (${variable}) {\n${call}\nUNWIND ${column(cypher)} AS ${x}\nRETURN collect(${x}) AS ${s}\n}`,
    variable: s,
  };
}

/**
 * The value of a scalar `@cypher` field as an expression, for `WHERE` predicates only: the first
 * row's value, or every value for a list field.
 */
export function scalarExpr(
  ctx: CypherContext,
  variable: string,
  cypher: CypherAnnotation,
  list: boolean,
): string {
  const call = statementCall(ctx, cypher, [], {}, variable);
  if (!list) return `head(COLLECT {\n${call}\nRETURN ${column(cypher)}\n})`;
  const x = ctx.variable("value");
  return `COLLECT {\n${call}\nUNWIND ${column(cypher)} AS ${x}\nRETURN ${x}\n}`;
}

/**
 * The rows of a `@cypher` field returning nodes, as subquery clauses binding each returned node to
 * `x` (`WHERE` predicates test them with `EXISTS { … }` / `COUNT { … }`: Neo4j rejects aggregating
 * statements inside list predicates such as `any(x IN COLLECT { … } WHERE …)`).
 */
export function nodeRows(
  ctx: CypherContext,
  variable: string,
  cypher: CypherAnnotation,
  x: string,
): string {
  const call = statementCall(ctx, cypher, [], {}, variable);
  return `${call}\nWITH ${column(cypher)} AS ${x} WHERE ${x} IS NOT NULL`;
}
