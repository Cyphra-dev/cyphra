import { describe, expect, it } from "vitest";
import type { CyphraClient } from "@cyphra/runtime";
import { createStudioDb } from "./db.js";
import { StudioRequestError } from "./values.js";

type Work = (tx: { run(q: string, p: unknown): Promise<unknown> }) => Promise<unknown>;

/** A client whose transactions run `work` once on a transaction failing with `error`. */
function failingClient(dialect: "neo4j" | "memgraph", error: Error): CyphraClient {
  const tx = {
    run: async () => {
      throw error;
    },
  };
  const run = (work: Work) => work(tx);
  return {
    dialect,
    withReadTransaction: run,
    withWriteTransaction: run,
  } as unknown as CyphraClient;
}

const transient = () =>
  Object.assign(new Error("Invalid duration string."), {
    code: "Memgraph.TransientError.MemgraphError.MemgraphError",
  });

describe("studio raw Cypher", () => {
  it("raises Memgraph's non-retryable transient errors as bad requests (no driver retries)", async () => {
    const db = createStudioDb({}, failingClient("memgraph", transient()));
    const err = await db.cypher('RETURN duration("P1M")', {}, "read").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StudioRequestError);
    expect((err as Error).message).toBe(
      "Memgraph cannot run this statement: Invalid duration string.",
    );
  });

  it("leaves write conflicts and Neo4j errors to the driver", async () => {
    const conflict = Object.assign(new Error("Cannot resolve conflicting transactions."), {
      code: "Memgraph.TransientError.MemgraphError.MemgraphError",
    });
    const mg = createStudioDb({}, failingClient("memgraph", conflict));
    await expect(mg.cypher("CREATE ()", {}, "write")).rejects.toBe(conflict);
    const neoErr = transient();
    const neo = createStudioDb({}, failingClient("neo4j", neoErr));
    await expect(neo.cypher("RETURN 1", {}, "read")).rejects.toBe(neoErr);
  });
});
