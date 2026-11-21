/**
 * Edge build of `cyphra` (Vercel Edge, Cloudflare Workers, Deno Deploy, browsers): schema, queries
 * and the runtime (whose own edge build connects over HTTP), without `@cyphra/migrator`, which
 * needs `neo4j-driver` and a Bolt connection. Bundlers pick it under the `workerd`, `edge-light`
 * and `worker` export conditions, so a generated client (`import … from "cyphra"`) runs there
 * unchanged. Run migrations from Node.js (`cyphra migrate deploy`).
 *
 * @packageDocumentation
 */

export * from "@cyphra/schema";
export * from "@cyphra/query";
export * from "@cyphra/runtime";
