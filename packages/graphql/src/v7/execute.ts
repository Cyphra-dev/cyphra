import type { CyphraClient } from "@cyphra/runtime";
import neo4j, { type Driver } from "neo4j-driver";

/** Runs one read statement and returns the values of its `this` column. */
export type ReadExecutor = (cypher: string, params: Record<string, unknown>) => Promise<unknown[]>;

export type ExecutorOptions = {
  /** A `neo4j-driver` driver. */
  driver?: Driver;
  /** Or a Cyphra client (`new CyphraClient(...)`). */
  client?: CyphraClient;
  /** Database name for `driver` (default database when omitted). */
  database?: string;
  /** Log each generated statement and its parameter keys (never values). */
  debug?: boolean;
};

export function createReadExecutor(opts: ExecutorOptions): ReadExecutor {
  const log = (cypher: string, params: Record<string, unknown>) => {
    if (opts.debug)
      console.debug("[cyphra/graphql] cypher:", cypher, "param keys:", Object.keys(params));
  };
  if (opts.client) {
    const client = opts.client;
    return async (cypher, params) => {
      log(cypher, params);
      const res = await client.withReadTransaction((tx) => tx.run(cypher, params));
      return res.records.map((r) => r.get("this"));
    };
  }
  if (opts.driver) {
    const driver = opts.driver;
    return async (cypher, params) => {
      log(cypher, params);
      const session = driver.session({
        database: opts.database,
        defaultAccessMode: neo4j.session.READ,
      });
      try {
        const res = await session.executeRead((tx) => tx.run(cypher, params));
        return res.records.map((r) => r.get("this"));
      } finally {
        await session.close();
      }
    };
  }
  throw new TypeError("@cyphra/graphql: pass `driver` (neo4j-driver) or `client` (CyphraClient).");
}
