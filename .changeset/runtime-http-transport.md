---
"@cyphra/runtime": minor
"cyphra": minor
"@cyphra/schema": patch
---

HTTP transport for edge runtimes (#104). `createClient` / `new CyphraClient` connect over the Neo4j
Query API (Neo4j 5.19+, Aura) with `fetch` when the URI is `https://` / `http://`, or with
`transport: "http"` (a `neo4j+s://host` URI maps to `https://host`). The whole typed client works
over it: CRUD, nested writes, upsert, aggregates, traversals, vector and full-text search,
`$cypher` and `$transaction` (explicit Query API transactions, cluster affinity header echoed,
transient errors retried), with the same logging, tracing and missing-index warnings. Options:
`token` (Bearer), `fetch`, `headers`, `maxRetryTimeMs`, `maxConcurrency` (default 4: keeps a
client from exhausting the server's HTTP worker threads with lock waits). Errors are `Neo4jHttpError` with the Neo4j
`code` and HTTP `status`.

`@cyphra/runtime` and `cyphra` ship an edge build without `neo4j-driver` or Node.js built-ins,
selected by the `workerd`, `edge-light` and `worker` export conditions (`@cyphra/runtime/edge` to
import it explicitly), so a generated client runs on Vercel Edge and Cloudflare Workers unchanged.
The ORM now builds parameters with its own `CypherInteger`, `CypherDateTime`, … classes (exported),
which `neo4j-driver` 5 and 6 send exactly like their own values. `@cyphra/schema` no longer imports
`node:buffer`, and loads `node:fs/promises` only when `parseSchemaFile` is called.
