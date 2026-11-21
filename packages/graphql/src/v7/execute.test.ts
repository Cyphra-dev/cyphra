import { CyphraClient, type CyphraEvent, type DriverLike } from "@cyphra/runtime";
import { describe, expect, it } from "vitest";
import { createExecutors } from "./execute.js";

function fakeDriver(): DriverLike {
  const run = async () => ({ records: [{ get: () => ({ title: "x" }) }], summary: {} });
  return {
    session: () => ({
      run,
      executeRead: async (work) => work({ run }),
      executeWrite: async (work) => work({ run }),
      close: async () => {},
    }),
    close: async () => {},
  };
}

describe("executors over a CyphraClient", () => {
  it("emit the client's query events", async () => {
    const events: CyphraEvent[] = [];
    const client = new CyphraClient({ driver: fakeDriver(), log: (e) => events.push(e) });
    const { read, write } = createExecutors({ client });
    expect(await read("MATCH (this:Post) RETURN this", { p: "secret" })).toEqual([{ title: "x" }]);
    expect(await write("CREATE (this:Post) RETURN this", {}, (rows) => rows.length)).toBe(1);
    expect(events).toMatchObject([
      { type: "query", operation: "graphql.read", rows: 1, params: { p: "<string>" } },
      { type: "query", operation: "graphql.write", rows: 1 },
    ]);
  });
});
