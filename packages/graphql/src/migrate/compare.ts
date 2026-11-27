/**
 * The dual-run check: the v7 result of an operation, mapped to the native shape by its
 * translation, against the native result of the translated operation.
 *
 * @packageDocumentation
 */

import type { DefinitionTranslation } from "./operations.js";
import { Unmapped } from "./operations.js";

/** One place where the two results differ. */
export type ResultDifference = {
  /** `movieFindMany.nodes[0].title`, or `errors`. */
  readonly path: string;
  readonly v7: unknown;
  readonly native: unknown;
  /** Set for a difference the native API has on purpose (e.g. cursors): not a failure. */
  readonly known?: string;
};

/** A GraphQL result (`data`, `errors`). */
export type GraphQLResultLike = {
  readonly data?: Record<string, unknown> | null;
  readonly errors?: readonly {
    readonly message: string;
    readonly path?: readonly (string | number)[];
  }[];
};

/** Options of {@link compareResults}. */
export type CompareOptions = {
  /** Compare lists in order (default: as multisets, since Neo4j returns rows in no set order). */
  readonly ordered?: boolean;
};

const UNMAPPED = "\u0000unmapped";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Unmapped);
}

/**
 * Replace the values of the native result that sit where the mapped v7 result has an
 * {@link Unmapped} (cursors, counts v7 does not return) on both sides, and list them as known
 * differences.
 */
function mask(
  v7: unknown,
  native: unknown,
  path: string,
  known: ResultDifference[],
): [unknown, unknown] {
  if (v7 instanceof Unmapped) {
    known.push({ path, v7: undefined, native, known: v7.reason });
    return [UNMAPPED, UNMAPPED];
  }
  if (isRecord(v7) && isRecord(native)) {
    const a: Record<string, unknown> = {};
    const b: Record<string, unknown> = { ...native };
    for (const [k, v] of Object.entries(v7)) {
      [a[k], b[k]] = mask(v, native[k], path ? `${path}.${k}` : k, known);
    }
    return [a, b];
  }
  if (Array.isArray(v7) && Array.isArray(native) && v7.length === native.length) {
    const pairs = v7.map((x, i) => mask(x, native[i], `${path}[${i}]`, known));
    return [pairs.map((p) => p[0]), pairs.map((p) => p[1])];
  }
  return [v7, native];
}

function canonical(v: unknown, ordered: boolean): unknown {
  if (Array.isArray(v)) {
    const items = v.map((x) => canonical(x, ordered));
    return ordered ? items : items.sort((a, b) => cmp(JSON.stringify(a), JSON.stringify(b)));
  }
  if (isRecord(v)) {
    return Object.fromEntries(
      Object.keys(v)
        .sort()
        .map((k) => [k, canonical(v[k], ordered)]),
    );
  }
  return v;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sameNumber(a: unknown, b: unknown): boolean {
  return (
    typeof a === "number" &&
    typeof b === "number" &&
    Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b))
  );
}

function diff(a: unknown, b: unknown, path: string, out: ResultDifference[]): void {
  if (a === b || sameNumber(a, b)) return;
  if (isRecord(a) && isRecord(b)) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      diff(a[k], b[k], path ? `${path}.${k}` : k, out);
    }
    return;
  }
  if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) {
    a.forEach((x, i) => diff(x, b[i], `${path}[${i}]`, out));
    return;
  }
  out.push({ path, v7: a, native: b });
}

/**
 * Compare the v7 result of an operation with the native result of its translation: the v7 `data`
 * is mapped to the native shape (`definition.mapData`), both are normalized (lists sorted unless
 * `ordered`), then compared value by value. Errors are compared by their number.
 *
 * @experimental
 */
export function compareResults(
  definition: DefinitionTranslation,
  v7: GraphQLResultLike,
  native: GraphQLResultLike,
  options: CompareOptions = {},
): ResultDifference[] {
  const out: ResultDifference[] = [];
  const v7Errors = v7.errors?.map((e) => e.message) ?? [];
  const nativeErrors = native.errors?.map((e) => e.message) ?? [];
  if (v7Errors.length !== nativeErrors.length) {
    out.push({ path: "errors", v7: v7Errors, native: nativeErrors });
  }
  if (!definition.mapData) return out;
  const expected = v7.data ? definition.mapData(v7.data) : v7.data;
  const known: ResultDifference[] = [];
  const reasonsFor: string[] = [];
  const [a, b] = mask(expected, native.data, "", known);
  const ordered = options.ordered ?? false;
  diff(canonical(a, ordered), canonical(b, ordered), "", out);
  // A v7 cursor passed in variables: the native API rejects it (a known difference).
  const cursors = definition.issues.some(
    (i) => i.kind === "known" && /cursor a client stored/.test(i.message),
  );
  if (cursors && out.length) {
    reasonsFor.push("a v7 cursor passed to the native API (cursors are not interchangeable)");
  }
  // Operations whose translation has a known semantic difference (connect is a MERGE, …).
  const reasons = definition.issues
    .filter((i) => i.kind === "known" && i.wholeResult)
    .map((i) => i.message);
  const all = [...reasons, ...reasonsFor];
  const label = (d: ResultDifference): ResultDifference => ({
    ...d,
    path: d.path === "" ? "data" : d.path,
    ...(all.length ? { known: all.join("; ") } : {}),
  });
  return [...out.map(label), ...known];
}
