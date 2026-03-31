import { describe, expect, it } from "vitest";
import type { CyphraDriverClient } from "@cyphra/core";
import { compileCypher } from "@cyphra/query";
import { applyConstraintStatements, runPendingMigrations } from "./runner.js";

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

describe("runPendingMigrations", () => {
  it("does not commit migration side effects when recording fails", async () => {
    const appliedNames = new Set<string>();
    let committedWrites = 0;
    let failRecordOnce = true;

    const runRead = async (text: string, params?: Record<string, unknown>) => {
      if (text.includes("MATCH (m:__CyphraMigration")) {
        const name = String(params?.name ?? "");
        return { records: appliedNames.has(name) ? [{}] : [] };
      }
      if (text.includes("CREATE CONSTRAINT")) {
        return { records: [] };
      }
      return { records: [] };
    };

    const client = {
      withSession: async (fn) =>
        fn({
          run: runRead,
          close: async () => undefined,
        }),
      withReadTransaction: async (fn) =>
        fn({
          run: runRead,
        }),
      withWriteTransaction: async (fn) => {
        const pendingApplied = new Set<string>();
        let pendingWrites = 0;
        const tx = {
          run: async (text: string, params?: Record<string, unknown>) => {
            if (text.includes("MATCH (m:__CyphraMigration")) {
              const name = String(params?.name ?? "");
              return { records: appliedNames.has(name) || pendingApplied.has(name) ? [{}] : [] };
            }
            if (text.includes("CREATE (m:__CyphraMigration")) {
              if (failRecordOnce) {
                failRecordOnce = false;
                throw new Error("record failed");
              }
              pendingApplied.add(String(params?.name ?? ""));
              return { records: [] };
            }
            pendingWrites += 1;
            return { records: [] };
          },
        };
        const out = await fn(tx);
        committedWrites += pendingWrites;
        for (const name of pendingApplied) {
          appliedNames.add(name);
        }
        return out;
      },
      runCypher: async (session, strings: TemplateStringsArray, ...values: unknown[]) => {
        const compiled = compileCypher(strings, values);
        return session.run(compiled.text, compiled.params);
      },
      runCompiled: async () => ({ records: [] }),
      runCompiledTx: async () => ({ records: [] }),
    } as unknown as CyphraDriverClient;

    const ordered = [
      {
        name: "001_init",
        checksum: "abc123",
        definition: {
          up: async ({ db }) => {
            await db.run`CREATE (:Test { k: ${1} })`;
          },
        },
      },
    ] as const;

    await expect(runPendingMigrations(client, ordered)).rejects.toThrow(/ran but recording/);
    expect(committedWrites).toBe(0);
    expect(appliedNames.has("001_init")).toBe(false);

    await expect(runPendingMigrations(client, ordered)).resolves.toEqual(["001_init"]);
    expect(committedWrites).toBe(1);
    expect(appliedNames.has("001_init")).toBe(true);
  });
});
