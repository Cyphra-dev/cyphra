/**
 * The baseline: hand-written Cypher. `boltRunner` runs it with `neo4j-driver` the way Cyphra does
 * (one session per call, a managed read or write transaction, explicit database) and maps records
 * to plain objects (Integer -> number, DateTime -> Date, as an application would).
 * `httpRunner` sends the same Cypher to the Neo4j Query API with `fetch`.
 */
import neo4j, { type Driver, type ManagedTransaction } from "neo4j-driver";

export type Mode = "read" | "write";
export type Row = Record<string, unknown>;
export type Runner = (
  cypher: string,
  params: Record<string, unknown>,
  mode: Mode,
) => Promise<Row[]>;

function plain(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (neo4j.isInt(value)) return neo4j.integer.toNumber(value);
  if (neo4j.isDateTime(value)) return new Date(value.toString());
  if (Array.isArray(value)) return value.map(plain);
  const out: Row = {};
  for (const [k, v] of Object.entries(value)) out[k] = plain(v);
  return out;
}

export function boltRunner(driver: Driver, database: string): Runner {
  return async (cypher, params, mode) => {
    const session = driver.session({
      database,
      defaultAccessMode: mode === "read" ? neo4j.session.READ : neo4j.session.WRITE,
    });
    try {
      const work = (tx: ManagedTransaction) => tx.run(cypher, params);
      const res =
        mode === "read" ? await session.executeRead(work) : await session.executeWrite(work);
      return res.records.map((r) => plain(r.toObject()) as Row);
    } finally {
      await session.close();
    }
  };
}

/** Integers for LIMIT / SKIP (a JavaScript number is sent as a float by neo4j-driver). */
export const int = (n: number) => neo4j.int(n);

export function httpRunner(opts: {
  uri: string;
  user: string;
  password: string;
  database: string;
}): Runner {
  const url = `${opts.uri.replace(/\/$/, "")}/db/${opts.database}/query/v2`;
  const headers = {
    "content-type": "application/json",
    accept: "application/json",
    authorization: `Basic ${Buffer.from(`${opts.user}:${opts.password}`).toString("base64")}`,
  };
  return async (cypher, params, mode) => {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        statement: cypher,
        parameters: jsonParams(params),
        accessMode: mode === "read" ? "READ" : "WRITE",
      }),
    });
    const body = (await res.json()) as {
      data?: { fields: string[]; values: unknown[][] };
      errors?: { code: string; message: string }[];
    };
    if (!res.ok || body.errors?.length)
      throw new Error(`Query API ${res.status}: ${body.errors?.[0]?.message ?? "error"}`);
    const { fields, values } = body.data!;
    return values.map((v) => Object.fromEntries(fields.map((f, i) => [f, v[i]])));
  };
}

/** neo4j-driver Integers in parameters become plain JSON numbers (the Query API reads them as INTEGER). */
function jsonParams(params: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params))
    out[k] = neo4j.isInt(v) ? neo4j.integer.toNumber(v) : v;
  return out;
}
