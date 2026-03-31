import { describe, expect, it } from "vitest";
import type { CyphraDriverClient } from "@cyphra/core";
import { applyConstraintStatements } from "./runner.js";

describe("applyConstraintStatements", () => {
  it("includes the failing DDL in the error message", async () => {
    let n = 0;
    const client = {
      withSession: async (
        fn: (session: { run: (c: string) => Promise<unknown> }) => Promise<void>,
      ) => {
        await fn({
          run: (cypher: string) => {
            n += 1;
            if (n === 2) {
              return Promise.reject(new Error(`simulated Neo4j error for: ${cypher}`));
            }
            return Promise.resolve();
          },
        });
      },
    } as unknown as CyphraDriverClient;

    const stmts = ["RETURN 1", "RETURN 2 AS bad"];
    let msg = "";
    try {
      await applyConstraintStatements(client, stmts);
    } catch (e) {
      msg = e instanceof Error ? e.message : String(e);
    }
    expect(msg).toMatch(/^DDL failed /);
    expect(msg).toContain("RETURN 2");
  });
});
