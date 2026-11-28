# @cyphra/runtime

> Part of [Cyphra](https://www.cyphra.dev), the TypeScript OGM (object-graph mapper) for Neo4j. **Runtime docs:** [www.cyphra.dev/runtime](https://www.cyphra.dev/runtime)

Neo4j driver wrapper for Cyphra: sessions, transactions, and safe execution of compiled Cypher.

Works with `neo4j-driver` **5.28+ and 6.x**, a peer dependency (`npm i @cyphra/runtime neo4j-driver`).
Pass `{ driver }` instead of a URI to reuse a `Driver` your app already has.

```ts
import { CyphraClient } from "@cyphra/runtime";
import { cypher } from "@cyphra/query";

const client = new CyphraClient({
  uri: process.env.NEO4J_URI!,
  user: process.env.NEO4J_USERNAME!,
  password: process.env.NEO4J_PASSWORD!,
});

await client.withSession(async (session) => {
  const res = await client.runCompiled(session, cypher`RETURN 1 AS n`);
  console.log(res.records[0].get("n"));
});

await client.close();
```

## Edge runtimes (HTTP)

On Vercel Edge, Cloudflare Workers, Deno Deploy or in browsers, connect with an `https://` URI (or
`transport: "http"`): the client then uses the [Neo4j Query API](https://neo4j.com/docs/query-api/current/)
over `fetch` (Neo4j 5.19+ or Aura), and bundlers pick a build without `neo4j-driver` under the
`workerd` / `edge-light` / `worker` conditions (or import `@cyphra/runtime/edge`). See
[HTTP transport](https://www.cyphra.dev/runtime#http-transport-edge-workers).
