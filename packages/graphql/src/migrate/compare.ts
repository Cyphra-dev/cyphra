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
  /**
   * `movieFindMany.nodes[0].title`; `errors` (not as many errors), or `errors[0].message`,
   * `errors[0].extensions.code`, `errors[0].path` (the errors, paired, differ).
   */
  readonly path: string;
  readonly v7: unknown;
  readonly native: unknown;
  /** Set for a difference the native API has on purpose (e.g. cursors): not a failure. */
  readonly known?: string;
};

/** A GraphQL result (`data`, `errors`). */
export type GraphQLResultLike = {
  readonly data?: Record<string, unknown> | null;
  readonly errors?: readonly GraphQLErrorLike[];
};

/** An error of a {@link GraphQLResultLike}. */
export type GraphQLErrorLike = {
  readonly message: string;
  readonly path?: readonly (string | number)[];
  readonly extensions?: { readonly code?: unknown; readonly [key: string]: unknown };
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

const PATH_MARK = "\u0000error-path";

/** Where `mark` sits in `v`, or `undefined`. */
function find(
  v: unknown,
  mark: string,
  path: (string | number)[],
): (string | number)[] | undefined {
  if (v === mark) return path;
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) {
      const p = find(v[i], mark, [...path, i]);
      if (p) return p;
    }
  } else if (isRecord(v)) {
    for (const [k, x] of Object.entries(v)) {
      const p = find(x, mark, [...path, k]);
      if (p) return p;
    }
  }
  return undefined;
}

/**
 * The native path of a v7 error path, through the translation's `mapData`: `full` when the
 * mapping follows the whole path (`movies[0].title` → `movieFindMany.nodes[0].title`), else the
 * native root field only, else `undefined` (no translation, or a path it cannot follow).
 */
function nativePath(
  definition: DefinitionTranslation,
  path: readonly (string | number)[] | undefined,
): { path: readonly (string | number)[]; full: boolean } | undefined {
  const map = definition.mapData;
  if (!map || !path?.length || typeof path[0] !== "string") return undefined;
  const at = (rest: readonly (string | number)[], leaf: unknown): unknown => {
    if (rest.length === 0) return leaf;
    const [head, ...tail] = rest;
    if (typeof head === "number") {
      const list: unknown[] = Array.from({ length: head }, () => ({}));
      list.push(at(tail, leaf));
      return list;
    }
    return { [head!]: at(tail, leaf) };
  };
  const tryMap = (data: unknown): unknown => {
    try {
      return map(data as Record<string, unknown>);
    } catch {
      return undefined;
    }
  };
  const found = find(tryMap(at(path, PATH_MARK)), PATH_MARK, []);
  if (found) return { path: found, full: true };
  const roots = Object.keys(rec(tryMap({ [path[0]]: null })));
  return roots.length === 1 ? { path: [roots[0]!], full: false } : undefined;
}

function rec(v: unknown): Record<string, unknown> {
  return isRecord(v) ? v : {};
}

/**
 * Whether a native error path matches the mapped v7 one: the same path, or (the mapping wraps a
 * value, `movies` → `movieFindMany.nodes`) a prefix of it ending at a field; the root field only
 * when the mapping did not follow the whole path.
 */
function samePath(
  mapped: { path: readonly (string | number)[]; full: boolean } | undefined,
  native: readonly (string | number)[] | undefined,
): boolean {
  if (!mapped) return true;
  if (!native?.length) return false;
  if (!mapped.full) return native[0] === mapped.path[0];
  if (native.length > mapped.path.length) return false;
  if (!native.every((x, i) => x === mapped.path[i])) return false;
  return mapped.path.slice(native.length).every((x) => typeof x === "string");
}

/** The parts of an error compared, and a key to pair the errors of both results by. */
function errorKey(e: GraphQLErrorLike, root: unknown): string {
  return JSON.stringify([root ?? null, e.extensions?.code ?? null, e.message]);
}

/**
 * Compare the errors of both results: their number, then, paired (by root field, code and
 * message), their `message`, `extensions.code` and `path` (the v7 path mapped to the native
 * shape).
 */
function compareErrors(
  definition: DefinitionTranslation,
  v7: readonly GraphQLErrorLike[],
  native: readonly GraphQLErrorLike[],
  out: ResultDifference[],
): void {
  const show = (e: GraphQLErrorLike) => ({
    message: e.message,
    ...(e.extensions?.code !== undefined ? { code: e.extensions.code } : {}),
    ...(e.path ? { path: e.path } : {}),
  });
  if (v7.length !== native.length) {
    out.push({ path: "errors", v7: v7.map(show), native: native.map(show) });
    return;
  }
  const a = v7
    .map((e) => ({ e, mapped: nativePath(definition, e.path) }))
    .sort((x, y) => cmp(errorKey(x.e, x.mapped?.path[0]), errorKey(y.e, y.mapped?.path[0])));
  const b = [...native].sort((x, y) => cmp(errorKey(x, x.path?.[0]), errorKey(y, y.path?.[0])));
  a.forEach(({ e, mapped }, i) => {
    const n = b[i]!;
    if (e.message !== n.message) {
      out.push({ path: `errors[${i}].message`, v7: e.message, native: n.message });
    }
    if (e.extensions?.code !== n.extensions?.code) {
      out.push({
        path: `errors[${i}].extensions.code`,
        v7: e.extensions?.code,
        native: n.extensions?.code,
      });
    }
    if (!samePath(mapped, n.path)) {
      out.push({ path: `errors[${i}].path`, v7: e.path, native: n.path });
    }
  });
}

/**
 * Compare the v7 result of an operation with the native result of its translation: the v7 `data`
 * is mapped to the native shape (`definition.mapData`), both are normalized (lists sorted unless
 * `ordered`), then compared value by value. Errors are compared by their number, then (paired)
 * by `message`, `extensions.code` and `path`, the v7 path mapped to the native shape.
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
  compareErrors(definition, v7.errors ?? [], native.errors ?? [], out);
  if (!definition.mapData) return out;
  const known: ResultDifference[] = [];
  // A failing non-null v7 root field nulls the whole `data`; native root fields are nullable, so
  // each failing one is `null` on its own.
  const nulled =
    v7.data === null &&
    isRecord(native.data) &&
    Object.values(native.data).every((v) => v === null);
  if (nulled) {
    known.push({
      path: "data",
      v7: null,
      native: native.data,
      known:
        "native root fields are nullable: a failing one is null, where v7 nulls the whole data",
    });
  } else {
    const expected = v7.data ? definition.mapData(v7.data) : v7.data;
    const [a, b] = mask(expected, native.data, "", known);
    const ordered = options.ordered ?? false;
    diff(canonical(a, ordered), canonical(b, ordered), "", out);
  }
  const reasonsFor: string[] = [];
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
