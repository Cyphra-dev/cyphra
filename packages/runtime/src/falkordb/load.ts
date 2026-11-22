/**
 * Loads the `falkordb` client (an optional peer dependency) on first use, so that Neo4j and
 * Memgraph users never need it installed. The edge build swaps this module for
 * `load-unavailable.ts` (FalkorDB needs TCP sockets).
 *
 * @packageDocumentation
 */

import { CyphraError } from "../orm/errors.js";

/** The part of the `falkordb` module Cyphra uses. */
export type FalkorDBModule = {
  FalkorDB: { connect(options?: Record<string, unknown>): Promise<unknown> };
};

/** `true` in the default build, `false` in the edge build. */
export const FALKORDB_AVAILABLE = true;

// A variable specifier: bundlers do not try to resolve (and fail on) the optional dependency.
const SPECIFIER = "falkordb";

let loading: Promise<FalkorDBModule> | undefined;

/** The `falkordb` module, or a `CyphraError` saying how to install it. */
export function loadFalkorDB(): Promise<FalkorDBModule> {
  loading ??= (import(/* webpackIgnore: true */ /* @vite-ignore */ SPECIFIER) as Promise<unknown>)
    .then((m) => {
      const mod = m as Partial<FalkorDBModule> & { default?: Partial<FalkorDBModule> };
      const FalkorDB = mod.FalkorDB ?? mod.default?.FalkorDB;
      if (!FalkorDB) throw new CyphraError("The falkordb package exports no FalkorDB client.");
      return { FalkorDB };
    })
    .catch((e: unknown) => {
      loading = undefined;
      if (e instanceof CyphraError) throw e;
      throw new CyphraError(
        'The FalkorDB transport needs the "falkordb" package: npm install falkordb',
        { cause: e },
      );
    });
  return loading;
}
