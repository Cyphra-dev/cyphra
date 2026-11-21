/**
 * Stand-in for `bolt.ts` in the edge build: Bolt needs TCP sockets, which Vercel Edge and
 * Cloudflare Workers do not offer. Connect over HTTP instead (`https://` URI).
 *
 * @packageDocumentation
 */

import type { DriverLike } from "./client.js";
import { CyphraError } from "./orm/errors.js";

export const BOLT_AVAILABLE = false;

export function createBoltDriver(uri: string): DriverLike {
  throw new CyphraError(
    `Bolt connections (${uri.split("://")[0]}://) are not available in this runtime (edge build of @cyphra/runtime: no TCP sockets). ` +
      `Use the HTTP transport: an https:// URI (e.g. https://<id>.databases.neo4j.io), or transport: "http".`,
  );
}
