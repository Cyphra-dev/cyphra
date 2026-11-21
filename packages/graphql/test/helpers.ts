import type { Driver } from "neo4j-driver";

export type Captured = { cypher: string; params: Record<string, unknown> };

/**
 * A stand-in for `neo4j-driver`: records every statement and answers with `rows` (values of the
 * `this` column), so resolvers can be tested without a database.
 */
export function fakeDriver(rows: (cypher: string) => unknown[] = () => []): {
  driver: Driver;
  statements: Captured[];
} {
  const statements: Captured[] = [];
  const tx = {
    run: async (cypher: string, params: Record<string, unknown>) => {
      statements.push({ cypher, params });
      return { records: rows(cypher).map((v) => ({ get: () => v })) };
    },
  };
  const driver = {
    session: () => ({
      executeRead: async <T>(fn: (t: typeof tx) => Promise<T>) => fn(tx),
      close: async () => {},
    }),
  } as unknown as Driver;
  return { driver, statements };
}
