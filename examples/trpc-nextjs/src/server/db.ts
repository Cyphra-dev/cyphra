import "server-only";
import { createClient, type Db } from "./cyphra.gen";

function env(...names: string[]): string {
  for (const name of names) {
    const value = process.env[name];
    if (value) return value;
  }
  throw new Error(`Missing ${names.join(" or ")}.`);
}

const globalForDb = globalThis as unknown as { cyphra?: Db };

/** One client (one driver and connection pool) per server process, reused across hot reloads. */
export function db(): Db {
  globalForDb.cyphra ??= createClient({
    uri: env("NEO4J_URI"),
    user: env("NEO4J_USERNAME", "NEO4J_USER"),
    password: env("NEO4J_PASSWORD"),
  });
  return globalForDb.cyphra;
}
