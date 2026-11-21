/**
 * @packageDocumentation
 * Edge build of `@cyphra/runtime` (Vercel Edge, Cloudflare Workers, Deno Deploy, browsers): the same
 * API, built without `neo4j-driver`, so it connects over HTTP (Neo4j Query API) only. Bundlers pick
 * it automatically under the `workerd`, `edge-light` and `worker` export conditions; import
 * `@cyphra/runtime/edge` to choose it explicitly.
 */

export * from "./index.js";
