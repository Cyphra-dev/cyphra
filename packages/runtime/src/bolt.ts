/**
 * Bolt (TCP) connections with `neo4j-driver`. The edge build of this package (`@cyphra/runtime`
 * under the `workerd` / `edge-light` / `worker` conditions, or `@cyphra/runtime/edge`) swaps this
 * module for `bolt-unavailable.ts`, so it never loads `neo4j-driver`.
 *
 * @packageDocumentation
 */

import neo4j, { type Config } from "neo4j-driver";
import type { DriverLike } from "./client.js";

/** `true` in the default build, `false` in the edge build. */
export const BOLT_AVAILABLE = true;

/** A `neo4j-driver` driver for `uri` with basic auth. */
export function createBoltDriver(
  uri: string,
  user: string,
  password: string,
  config?: Config,
): DriverLike {
  return neo4j.driver(uri, neo4j.auth.basic(user, password), config) as unknown as DriverLike;
}
