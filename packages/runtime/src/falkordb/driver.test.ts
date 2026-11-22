import { describe, expect, it } from "vitest";
import { createOrm } from "../orm/client.js";
import { parseSchema, resolveSchema } from "@cyphra/schema";
import { CyphraClient } from "../client.js";
import { UnsupportedFeatureError } from "../orm/errors.js";
import {
  FalkorDBDriver,
  FalkorDBError,
  parseConstraintCommand,
  type FalkorDBClientLike,
  type FalkorDBGraphLike,
  type FalkorDBReply,
} from "./driver.js";

type Call = { method: string; args: unknown[] };

/** A fake `falkordb` client recording what it is asked. */
function fakeClient(reply: (query: string) => FalkorDBReply = () => ({})) {
  const calls: Call[] = [];
  let closed = false;
  const graph: FalkorDBGraphLike = {
    query: async (q) => (calls.push({ method: "query", args: [q] }), reply(q)),
    roQuery: async (q) => {
      calls.push({ method: "roQuery", args: [q] });
      if (q.startsWith("CALL db.constraints()")) return { headers: [], data: [] };
      return reply(q);
    },
    constraintCreate: async (...args) => void calls.push({ method: "constraintCreate", args }),
    constraintDrop: async (...args) => void calls.push({ method: "constraintDrop", args }),
  };
  const client: FalkorDBClientLike = {
    selectGraph: (name) => (calls.push({ method: "selectGraph", args: [name] }), graph),
    close: async () => {
      closed = true;
    },
  };
  return { client, calls, closed: () => closed };
}

describe("FalkorDB driver", () => {
  it("sends rewritten statements with a parameter header, read-only reads with RO_QUERY", async () => {
    const fake = fakeClient(() => ({ headers: ["n"], data: [{ n: 1n }] }));
    const driver = new FalkorDBDriver({ graph: "g", client: fake.client });
    const s = driver.session();
    const r = await s.run("MATCH (n) WHERE elementId(n) = $id RETURN count(n) AS n", { id: "3" });
    expect(r.records[0]!.get("n")).toEqual(expect.objectContaining({ value: 1n }));
    expect(r.summary.database.name).toBe("g");
    await s.executeRead((tx) => tx.run("RETURN 1"));
    expect(fake.calls.map((c) => [c.method, ...c.args])).toEqual([
      ["selectGraph", "g"],
      ["query", 'CYPHER id="3" MATCH (n) WHERE id(n) = toInteger($id) RETURN count(n) AS n'],
      ["roQuery", "RETURN 1"],
    ]);
    // A client passed in is shared, never closed.
    await driver.close();
    expect(fake.closed()).toBe(false);
  });

  it("runs GRAPH.CONSTRAINT statements as the Redis command", async () => {
    const fake = fakeClient();
    const driver = new FalkorDBDriver({ graph: "g", client: fake.client });
    await driver.session().run("GRAPH.CONSTRAINT CREATE UNIQUE NODE `My Label` PROPERTIES 2 `a` b");
    await driver.session().run("GRAPH.CONSTRAINT DROP MANDATORY RELATIONSHIP T PROPERTIES 1 p");
    expect(fake.calls.filter((c) => c.method.startsWith("constraint"))).toEqual([
      { method: "constraintCreate", args: ["UNIQUE", "NODE", "My Label", "a", "b"] },
      { method: "constraintDrop", args: ["MANDATORY", "RELATIONSHIP", "T", "p"] },
    ]);
    expect(() =>
      parseConstraintCommand("GRAPH.CONSTRAINT CREATE UNIQUE NODE L PROPERTIES 2 a"),
    ).toThrow(FalkorDBError);
    expect(parseConstraintCommand("MATCH (n) RETURN n")).toBeUndefined();
  });

  it("serializes write work of one driver", async () => {
    const order: string[] = [];
    const fake = fakeClient();
    const driver = new FalkorDBDriver({ graph: "g", client: fake.client });
    const s = driver.session();
    await Promise.all([
      s.executeWrite(async () => {
        order.push("a1");
        await new Promise((r) => setTimeout(r, 20));
        order.push("a2");
      }),
      s.executeWrite(async () => {
        order.push("b1");
      }),
    ]);
    expect(order).toEqual(["a1", "a2", "b1"]);
  });

  it("wraps server errors with a code", async () => {
    const fake = fakeClient(() => {
      throw new Error("unique constraint violation on node of type User");
    });
    const driver = new FalkorDBDriver({ graph: "g", client: fake.client });
    const e = await driver
      .session()
      .run("CREATE (:User)")
      .catch((x: unknown) => x);
    expect(e).toBeInstanceOf(FalkorDBError);
    expect((e as FalkorDBError).code).toBe("FalkorDB.ConstraintViolation");
  });
});

describe("CyphraClient on FalkorDB", () => {
  const schema = resolveSchema(parseSchema("node FkU {\n  id String @id\n}\n"));

  it("connects through the falkordb option, and refuses $transaction", async () => {
    const fake = fakeClient();
    const client = new CyphraClient({ falkordb: { graph: "g", client: fake.client } });
    expect([client.dialect, client.transport]).toEqual(["falkordb", "falkordb"]);
    const db = createOrm(schema, { client }) as unknown as {
      $transaction(fn: () => Promise<unknown>): Promise<unknown>;
    };
    await expect(db.$transaction(async () => 1)).rejects.toBeInstanceOf(UnsupportedFeatureError);
    await client.close();
  });
});
