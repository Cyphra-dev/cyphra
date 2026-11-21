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
      const work = async (tx: { run(q: string, p: AnyRecord): PromiseLike<unknown> }) =>
        ((await tx.run(query, p)) as RunResult).records.map((r) => r.toObject());
      return mode === "read" ? client.withReadTransaction(work) : client.withWriteTransaction(work);
    },
  };
}
