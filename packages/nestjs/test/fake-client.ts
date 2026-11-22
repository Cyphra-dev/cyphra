import type { CyphraClientLike } from "../src/index.js";

/** Records which client (root or transaction) each call went to. */
export interface FakeCall {
  on: string;
  op: string;
}

export interface FakeClient extends CyphraClientLike {
  user: { findMany(): Promise<string> };
  label: string;
  calls: FakeCall[];
  transactions: { committed: number; rolledBack: number };
  disconnected: number;
  failPing?: Error;
}

/** A stand-in for a generated client: `$transaction` hands out a numbered transaction client. */
export function fakeClient(): FakeClient {
  let seq = 0;
  const calls: FakeCall[] = [];
  const transactions = { committed: 0, rolledBack: 0 };
  const client: FakeClient = {
    label: "root",
    calls,
    transactions,
    disconnected: 0,
    user: {
      findMany: async () => {
        calls.push({ on: "root", op: "user.findMany" });
        return "root";
      },
    },
    async $cypher() {
      if (client.failPing) throw client.failPing;
      calls.push({ on: "root", op: "$cypher" });
      return [{ ok: 1 }];
    },
    async $transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
      const name = `tx${++seq}`;
      const tx = {
        user: {
          findMany: async () => {
            calls.push({ on: name, op: "user.findMany" });
            return name;
          },
        },
        async $cypher() {
          calls.push({ on: name, op: "$cypher" });
          return [];
        },
      };
      try {
        const result = await fn(tx);
        transactions.committed++;
        return result;
      } catch (e) {
        transactions.rolledBack++;
        throw e;
      }
    },
    async $disconnect() {
      client.disconnected++;
    },
  };
  return client;
}
