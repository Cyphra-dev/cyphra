import type { Driver } from "neo4j-driver";

export type Captured = {
  cypher: string;
  params: Record<string, unknown>;
  /** Transaction the statement ran in. */
  mode: "read" | "write";
};

/**
 * A stand-in for `neo4j-driver`: records every statement and answers with `rows` (values of the
 * `this` column for the compat compiler's statements, whole records — `{ row }`, `{ c }`, … — for
 * the engine's), so resolvers can be tested without a database.
 */
export function fakeDriver(rows: (cypher: string) => unknown[] = () => []): {
  driver: Driver;
  statements: Captured[];
} {
  const statements: Captured[] = [];
  const tx = (mode: Captured["mode"]) => ({
    run: async (cypher: string, params: Record<string, unknown>) => {
      statements.push({ cypher, params, mode });
      return {
        records: rows(cypher).map((v) => ({ get: () => v, toObject: () => v as object })),
      };
    },
  });
  type Tx = ReturnType<typeof tx>;
  const driver = {
    session: () => ({
      executeRead: async <T>(fn: (t: Tx) => Promise<T>) => fn(tx("read")),
      executeWrite: async <T>(fn: (t: Tx) => Promise<T>) => fn(tx("write")),
      close: async () => {},
    }),
  } as unknown as Driver;
  return { driver, statements };
}
