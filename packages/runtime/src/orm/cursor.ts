/**
 * Keyset cursors of `findMany` (`cursor: { after, before }`, `select: { $cursor: true }`).
 *
 * A cursor is opaque: a versioned, base64url-encoded record of the model, a fingerprint of the
 * `orderBy` it was made for, and the values of the boundary node's sort keys. The keys are the
 * `orderBy` keys followed by the model's `@id` (or the element id when it has none), so the order
 * is total and a page boundary never splits nodes that tie. A page after a cursor is the nodes
 * strictly after those values in that order, whatever was inserted or deleted since: unlike an
 * offset, it does not shift.
 *
 * @packageDocumentation
 */

import type { ResolvedNodeModel } from "@cyphra/schema";
import { CyphraValidationError } from "./errors.js";
import {
  compileSortKeys,
  intParam,
  q,
  type QueryContext,
  type SortKey,
  type SortKeyValue,
} from "./compile.js";
import { decodeCount, decodeScalar, encodeFilterValue } from "./values.js";

type AnyRecord = Record<string, unknown>;

/** Version of the cursor encoding (the first element of the encoded record). */
const VERSION = 1;

function isPlainObject(v: unknown): v is AnyRecord {
  return typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Date);
}

/** `cursor: { after?, before? }` of `findMany`, checked. */
export type CursorArgs = { readonly after?: string; readonly before?: string };

/** Parse `cursor` (`undefined` when absent or empty). */
export function parseCursorArgs(model: ResolvedNodeModel, cursor: unknown): CursorArgs | undefined {
  if (cursor === undefined || cursor === null) return undefined;
  const where = `${model.name}.findMany: cursor`;
  if (!isPlainObject(cursor)) {
    throw new CyphraValidationError(`${where} takes { after?: string, before?: string }.`);
  }
  const out: { after?: string; before?: string } = {};
  for (const [k, v] of Object.entries(cursor)) {
    if (v === undefined || v === null) continue;
    if (k !== "after" && k !== "before") {
      throw new CyphraValidationError(`${where}: unknown key "${k}" (use after, before).`);
    }
    if (typeof v !== "string") {
      throw new CyphraValidationError(`${where}.${k} must be a cursor string ($cursor of a row).`);
    }
    out[k] = v;
  }
  return out.after === undefined && out.before === undefined ? undefined : out;
}

/** The sort keys of a cursor query on `alias`: `orderBy`, then the `@id` (or the element id). */
export function cursorSortKeys(
  ctx: QueryContext,
  model: ResolvedNodeModel,
  alias: string,
  orderBy: unknown,
): SortKey[] {
  const keys = compileSortKeys(ctx, model, alias, orderBy);
  const id = model.fields.find((f) => f.kind === "scalar" && f.id);
  if (id?.kind === "scalar") {
    keys.push({
      expr: `${alias}.${q(id.name)}`,
      dir: "ASC",
      value: { kind: "scalar", field: id, owner: model.name },
    });
  } else {
    keys.push({ expr: `elementId(${alias})`, dir: "ASC", value: { kind: "text" } });
  }
  return keys;
}

/** A JSON-safe copy of `v`: `Date` and `bigint` are tagged so that they decode to themselves. */
function toJson(v: unknown): unknown {
  if (v instanceof Date) return { $d: v.toISOString() };
  if (typeof v === "bigint") return { $b: v.toString() };
  if (Array.isArray(v)) return v.map(toJson);
  if (isPlainObject(v))
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, toJson(x)]));
  return v;
}

function fromJson(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(fromJson);
  if (isPlainObject(v)) {
    const keys = Object.keys(v);
    if (keys.length === 1 && typeof v.$d === "string") return new Date(v.$d);
    if (keys.length === 1 && typeof v.$b === "string") return BigInt(v.$b);
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fromJson(x)]));
  }
  return v;
}

/** 32-bit FNV-1a of `text`, in base 36. */
function fingerprint(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/** What a cursor is tied to: the model and its `orderBy` (as given, in order). */
export function orderFingerprint(model: ResolvedNodeModel, orderBy: unknown): string {
  const list = orderBy === undefined || orderBy === null ? [] : [orderBy].flat();
  return fingerprint(`${model.name}\u0000${JSON.stringify(toJson(list))}`);
}

function base64url(text: string): string {
  let bin = "";
  for (const b of new TextEncoder().encode(text)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function unbase64url(text: string): string {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new Error("not base64url");
  const bin = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  return new TextDecoder("utf-8", { fatal: true }).decode(
    Uint8Array.from(bin, (c) => c.charCodeAt(0)),
  );
}

/** The value of one sort key as read from a row (`raw`), as plain JS. */
function readKey(value: SortKeyValue, raw: unknown): unknown {
  if (raw === null || raw === undefined) return null;
  switch (value.kind) {
    case "scalar":
      return decodeScalar(value.field, raw);
    case "count":
      return decodeCount(raw);
    case "text":
      return String(raw);
    case "number":
      return Number(raw);
  }
}

/** Encode the cursor of a row whose sort keys `keys` had the values `raw`. */
export function encodeCursor(fingerprint: string, keys: readonly SortKey[], raw: unknown): string {
  const list = Array.isArray(raw) ? raw : [];
  const values = keys.map((k, i) => toJson(readKey(k.value, list[i])));
  return base64url(JSON.stringify([VERSION, fingerprint, values]));
}

/**
 * The values of the sort keys a cursor holds, each bound as a parameter (`null` for a null value).
 * Throws a {@link CyphraValidationError} for a malformed cursor, or one made for another model or
 * `orderBy`.
 */
export function decodeCursor(
  ctx: QueryContext,
  model: ResolvedNodeModel,
  fingerprint: string,
  keys: readonly SortKey[],
  cursor: string,
  side: "after" | "before",
): (string | null)[] {
  const invalid = () =>
    new CyphraValidationError(
      `${model.name}.findMany: cursor.${side} is not a valid cursor for this query (malformed, or made for another model or orderBy).`,
    );
  let record: unknown;
  try {
    record = JSON.parse(unbase64url(cursor));
  } catch {
    throw invalid();
  }
  if (
    !Array.isArray(record) ||
    record.length !== 3 ||
    record[0] !== VERSION ||
    record[1] !== fingerprint ||
    !Array.isArray(record[2]) ||
    record[2].length !== keys.length
  ) {
    throw invalid();
  }
  const values = (record[2] as unknown[]).map(fromJson);
  return keys.map((k, i) => {
    const v = values[i];
    if (v === null) return null;
    switch (k.value.kind) {
      case "scalar":
        try {
          return ctx.param(encodeFilterValue(k.value.field, v, k.value.owner));
        } catch {
          throw invalid();
        }
      case "count":
        if (typeof v !== "number" || !Number.isInteger(v) || v < 0) throw invalid();
        return ctx.param(intParam(v));
      case "text":
        if (typeof v !== "string") throw invalid();
        return ctx.param(v);
      case "number":
        if (typeof v !== "number") throw invalid();
        return ctx.param(v);
    }
  });
}

/**
 * The predicate keeping the rows strictly `after` (or `before`) the boundary whose key values are
 * `params`, in the order of `keys`; `vars` hold each key's value per row. Nulls sort last
 * ascending (first descending), as in Cypher.
 */
export function keysetPredicate(
  keys: readonly SortKey[],
  vars: readonly string[],
  params: readonly (string | null)[],
  side: "after" | "before",
): string {
  const branches: string[] = [];
  const equal: string[] = [];
  keys.forEach((k, i) => {
    const v = vars[i]!;
    const p = params[i] ?? null;
    // Further in the walk direction: a larger value when walking up the order.
    const larger = (side === "after") === (k.dir === "ASC");
    const beyond = larger
      ? p === null
        ? null // nothing sorts after null
        : `(${v} > ${p} OR ${v} IS NULL)`
      : p === null
        ? `${v} IS NOT NULL`
        : `${v} < ${p}`;
    if (beyond) branches.push([...equal, beyond].join(" AND "));
    equal.push(p === null ? `${v} IS NULL` : `${v} = ${p}`);
  });
  return branches.length ? branches.map((b) => `(${b})`).join(" OR ") : "false";
}
