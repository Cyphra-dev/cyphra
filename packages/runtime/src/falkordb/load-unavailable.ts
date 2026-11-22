/**
 * Edge build stand-in for `load.ts`: FalkorDB speaks the Redis protocol over TCP, which edge
 * runtimes do not offer.
 *
 * @packageDocumentation
 */

import { CyphraError } from "../orm/errors.js";
import type { FalkorDBModule } from "./load.js";

export type { FalkorDBModule };

/** `true` in the default build, `false` in the edge build. */
export const FALKORDB_AVAILABLE = false;

export function loadFalkorDB(): Promise<FalkorDBModule> {
  return Promise.reject(
    new CyphraError(
      "FalkorDB is not available in the edge build of @cyphra/runtime (it needs TCP sockets): run on Node.js, Bun or Deno.",
    ),
  );
}
