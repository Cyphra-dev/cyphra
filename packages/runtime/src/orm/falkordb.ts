/**
 * ORM behaviour specific to the `"falkordb"` dialect (the statements themselves are rewritten by
 * the FalkorDB transport, `../falkordb/rewrite.ts`).
 *
 * @packageDocumentation
 */

import type { SchemaModel } from "@cyphra/schema";
import type { TransactionLike } from "../client.js";
import { unsupportedOnFalkorDB } from "../dialect.js";
import { decodeCount } from "./values.js";
import { candidates, parseUniqueViolation, uniqueConstraintError } from "./unique.js";
import { q } from "./compile.js";
import type { UnsupportedFeatureError } from "./errors.js";
import { numericGuard, type NumericCheck } from "./rules.js";

type AnyRecord = Record<string, unknown>;

/** `$transaction` on FalkorDB, which has no multi-statement transactions. */
export function falkordbTransactionError(): UnsupportedFeatureError {
  return unsupportedOnFalkorDB(
    "$transaction (an interactive transaction)",
    "FalkorDB runs each statement atomically but has no multi-statement transactions, so a rollback cannot be guaranteed. Run the operations one by one, or write them as one statement with $cypher.",
  );
}

function isPlain(v: unknown): v is AnyRecord {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v) as unknown;
  return proto === Object.prototype || proto === null;
}

/** Every map in `params` (property maps of `CREATE`, `SET +=`, `UNWIND` rows), outermost first. */
function propertyMaps(value: unknown, out: AnyRecord[][] = [], depth = 0): AnyRecord[][] {
  if (depth > 4) return out;
  if (Array.isArray(value)) {
    const maps = value.filter(isPlain);
    if (maps.length) out.push(maps);
    for (const v of value) if (!isPlain(v)) propertyMaps(v, out, depth + 1);
    for (const m of maps) for (const v of Object.values(m)) propertyMaps(v, out, depth + 1);
  } else if (isPlain(value)) {
    out.push([value]);
    for (const v of Object.values(value)) propertyMaps(v, out, depth + 1);
  }
  return out;
}

const key = (v: unknown): string => {
  try {
    return JSON.stringify(v, (_k, x: unknown) => (typeof x === "bigint" ? x.toString() : x));
  } catch {
    return String(v);
  }
};

/**
 * A FalkorDB uniqueness violation as a `UniqueConstraintError` with its fields. FalkorDB names
 * only the label, so the statement's parameters are searched for the values of each unique
 * constraint of that label: the one whose values are repeated in the statement or already stored
 * is the one that failed. Anything else is returned unchanged.
 */
export async function falkordbUniqueError(
  schema: SchemaModel,
  err: unknown,
  text: string,
  params: AnyRecord,
  tx: TransactionLike,
): Promise<unknown> {
  const message = (err as { message?: unknown } | null)?.message;
  const parsed = typeof message === "string" ? parseUniqueViolation(message) : undefined;
  const plain = uniqueConstraintError(schema, err);
  if (!parsed || !plain) return err;
  const groups = propertyMaps(params);
  // Single assignments, `SET n.email = $p3`: one map per statement.
  const assigned: AnyRecord = {};
  for (const m of text.matchAll(/\b\w+\.(?:`((?:[^`]|``)+)`|(\w+)) = \$(\w+)\b(?![.[])/g)) {
    const prop = (m[1] ?? m[2]!).replace(/``/g, "`");
    if (m[3]! in params) assigned[prop] = params[m[3]!];
  }
  if (Object.keys(assigned).length) groups.push([assigned]);
  const all = candidates(schema, parsed);
  for (const c of all) {
    for (const maps of groups) {
      const rows = maps.filter((m) => c.fields.every((f) => m[f] !== undefined && m[f] !== null));
      if (!rows.length) continue;
      const seen = new Set<string>();
      for (const row of rows) {
        const k = key(c.fields.map((f) => row[f]));
        if (seen.has(k)) return uniqueConstraintError(schema, err, c.fields);
        seen.add(k);
      }
      const values: AnyRecord = {};
      const where = c.fields.map((f, i) => {
        values[`v${i}`] = rows.map((r) => r[f]);
        return rows.length === 1 ? `n.${q(f)} = $v${i}[0]` : `n.${q(f)} IN $v${i}`;
      });
      const pattern =
        parsed.entity === "node" ? `(n:${q(parsed.label)})` : `()-[n:${q(parsed.label)}]-()`;
      try {
        const res = (await tx.run(
          `MATCH ${pattern} WHERE ${where.join(" AND ")} RETURN count(n) AS c`,
          values,
        )) as { records: { get(k: string): unknown }[] };
        if (decodeCount(res.records[0]?.get("c")) > 0) {
          return uniqueConstraintError(schema, err, c.fields);
        }
      } catch {
        // Best effort: keep the error without fields.
      }
    }
  }
  // No stored duplicate (e.g. one value written to several nodes): the constraint whose fields the
  // statement writes.
  const written = all.filter((c) =>
    groups.some((maps) =>
      maps.some((m) => c.fields.every((f) => m[f] !== undefined && m[f] !== null)),
    ),
  );
  if (written.length === 1) return uniqueConstraintError(schema, err, written[0]!.fields);
  return plain;
}

/**
 * The `SET` of an edge's number updates (`r.w = coalesce(r.w, 0) + $p`), applied only when the
 * values it would produce pass their `@min` / `@max` checks: ` WITH a, b, r, [broken checks] AS
 * broken FOREACH (… | SET …)`. Neo4j checks after updating and rolls back; FalkorDB cannot.
 */
export function falkordbGuardedEdgeSet(
  sets: readonly string[],
  checks: readonly NumericCheck[],
  /** The variables in scope (start node, end node, edge), kept by the `WITH`. */
  keep: readonly string[],
  /** The variable holding the broken checks. */
  broken: string,
): string {
  const before = checks.map((c) => {
    const set = sets.find((s) => s.startsWith(`${c.result} = `));
    return set ? { ...c, result: set.slice(c.result.length + 3) } : c;
  });
  const guard = numericGuard(before) ?? "[]";
  return (
    ` WITH ${keep.join(", ")}, ${guard} AS ${broken}` +
    ` FOREACH (x IN CASE WHEN size(${broken}) = 0 THEN [1] ELSE [] END | SET ${sets.join(", ")})`
  );
}
