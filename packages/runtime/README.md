# @cyphra/runtime

Neo4j driver wrapper for Cyphra: sessions, transactions, and safe execution of compiled Cypher.

```ts
import { CyphraClient } from "@cyphra/runtime";
import { cypher } from "@cyphra/query";

const client = new CyphraClient({
  uri: process.env.NEO4J_URI!,
  user: process.env.NEO4J_USER!,
  password: process.env.NEO4J_PASSWORD!,
});

await client.withSession(async (session) => {
  const res = await client.runCompiled(session, cypher`RETURN 1 AS n`);
  console.log(res.records[0].get("n"));
});

await client.close();
```
