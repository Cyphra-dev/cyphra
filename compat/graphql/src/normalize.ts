import type { ExecutionResult } from "graphql";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
/** Datetimes this close to the run are generated (`@timestamp`, `datetime()`); seeds use old dates. */
const GENERATED_WINDOW_MS = 24 * 60 * 60 * 1000;

export type NormalizedResult = {
  events?: NormalizedResult[];
  data?: unknown;
  errors?: {
    message: string;
    path?: readonly (string | number)[];
    code?: unknown;
    issues?: unknown;
  }[];
};

function mask(value: string, now: number): string {
  if (UUID.test(value)) return "<generated-id>";
  if (ISO_DATETIME.test(value)) {
    const t = Date.parse(value);
    if (!Number.isNaN(t) && Math.abs(t - now) < GENERATED_WINDOW_MS) return "<generated-datetime>";
  }
  return value;
}

function canonical(value: unknown): string {
  return JSON.stringify(value);
}

type WalkOptions = { ordered: boolean; now: number; maskTimestamps: boolean };

function walk(value: unknown, opts: WalkOptions): unknown {
  const { ordered, now } = opts;
  if (typeof value === "string") return mask(value, now);
  // Subscription events: `timestamp` (milliseconds since the epoch) of the transaction.
  if (
    opts.maskTimestamps &&
    typeof value === "number" &&
    Number.isInteger(value) &&
    Math.abs(value - now) < GENERATED_WINDOW_MS
  )
    return "<generated-timestamp>";
  // Float aggregates (avg, sum) depend on Neo4j's summation order: compare at 12 significant digits.
  if (typeof value === "number" && !Number.isInteger(value)) return Number(value.toPrecision(12));
  if (Array.isArray(value)) {
    const items = value.map((v) => walk(v, opts));
    if (!ordered)
      items.sort((a, b) =>
        canonical(a) < canonical(b) ? -1 : canonical(a) > canonical(b) ? 1 : 0,
      );
    return items;
  }
  if (value && typeof value === "object") {
    // GraphQL results have field order from the selection set; keep it, it is part of the contract.
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = walk(v, opts);
    return out;
  }
  return value;
}

/**
 * Turns an execution result into a stable, comparable JSON value: generated ids and
 * timestamps are masked, floats are rounded to 12 significant digits, and arrays are sorted unless the operation is `# ordered`.
 * `maskTimestamps` also masks integers within a day of now (epoch milliseconds of subscription events).
 * Errors keep their message, path, `extensions.code` and `extensions.issues` only.
 */
export function normalizeResult(
  result: ExecutionResult,
  {
    ordered,
    now = Date.now(),
    maskTimestamps = false,
  }: { ordered: boolean; now?: number; maskTimestamps?: boolean },
): NormalizedResult {
  const out: NormalizedResult = {};
  if (result.data !== undefined)
    out.data = walk(JSON.parse(JSON.stringify(result.data)), { ordered, now, maskTimestamps });
  if (result.errors?.length) {
    out.errors = result.errors.map((e) => ({
      message: e.message,
      ...(e.path ? { path: e.path } : {}),
      ...(e.extensions?.code !== undefined ? { code: e.extensions.code } : {}),
      // Validation issues of the native API (their paths are part of its contract).
      ...(Array.isArray(e.extensions?.issues) && e.extensions.issues.length > 0
        ? { issues: e.extensions.issues }
        : {}),
    }));
  }
  return out;
}

export function stringifyResult(result: NormalizedResult): string {
  return `${JSON.stringify(result, null, 2)}\n`;
}
