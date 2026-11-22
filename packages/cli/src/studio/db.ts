import { int, type CyphraClient } from "@cyphra/runtime";
import type { StudioDb, StudioDelegate } from "./api.js";
import { StudioRequestError } from "./values.js";

type AnyRecord = Record<string, unknown>;

/** Whole JSON numbers in raw Cypher parameters become Cypher `INTEGER`s (as in Neo4j Browser). */
function encodeParam(v: unknown): unknown {
  if (typeof v === "number" && Number.isSafeInteger(v)) return int(v);
  if (Array.isArray(v)) return v.map(encodeParam);
  if (typeof v === "object" && v !== null) {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, encodeParam(x)]));
  }
  return v;
}

type RunResult = { records: { toObject(): AnyRecord }[] };

/**
 * Memgraph reports many errors that retrying cannot fix (an invalid duration string, …) as
 * transient, which the driver would retry for 30 seconds. Raise those at once as a bad request;
 * only write conflicts between transactions are left to the driver's retries.
 */
function noRetry(e: unknown): unknown {
  const err = e as { code?: unknown; message?: unknown } | null;
  if (
    typeof err?.code === "string" &&
    err.code.startsWith("Memgraph.TransientError") &&
    typeof err.message === "string" &&
    !/conflicting transactions|retry this transaction/i.test(err.message)
  ) {
    return new StudioRequestError(`Memgraph cannot run this statement: ${err.message}`);
  }
  return e;
}

/** {@link StudioDb} over an ORM client built with `createOrm` and its {@link CyphraClient}. */
export function createStudioDb(orm: Record<string, unknown>, client: CyphraClient): StudioDb {
  return {
    delegate(model) {
      const key = model.charAt(0).toLowerCase() + model.slice(1);
      const d = orm[key] as StudioDelegate | undefined;
      if (!d || key.startsWith("$")) throw new StudioRequestError(`Unknown model "${model}".`);
      return d;
    },
    async cypher(query, params, mode) {
      const p = encodeParam(params) as AnyRecord;
      const memgraph = client.dialect === "memgraph";
      const work = async (tx: { run(q: string, p: AnyRecord): PromiseLike<unknown> }) => {
        try {
          return ((await tx.run(query, p)) as RunResult).records.map((r) => r.toObject());
        } catch (e) {
          throw memgraph ? noRetry(e) : e;
        }
      };
      return mode === "read" ? client.withReadTransaction(work) : client.withWriteTransaction(work);
    },
  };
}
