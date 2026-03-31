# @cyphra/orm

CRUD and graph helpers driven by a parsed **`.cyphra`** document and **`CyphraClient`**.

## Install

```bash
npm install @cyphra/orm
```

Typically used together with **`@cyphra/schema`** and **`cyphra`** (or **`@cyphra/runtime`**) for the client.

## Example

```ts
import { parseSchema } from "@cyphra/schema";
import { CyphraClient, CyphraNeo4j } from "cyphra";
import { createNodeCrud, queryRelatedNodes, runCompiledBatchWrite } from "@cyphra/orm";

const doc = parseSchema(`node Post { id String @id slug String @unique title String }`);

const client = new CyphraClient({
  adapter: new CyphraNeo4j({ uri, user, password, database }),
});

const posts = createNodeCrud(client, doc, "Post");
await posts.findUnique({ slug: "hello" });

await queryRelatedNodes(client, {
  fromLabel: "User",
  idField: "id",
  anchorId: "u1",
  relType: "WROTE",
  toLabel: "Post",
  maxHops: 2,
});
```

## Documentation

**[cyphra.dev — Graph ORM](https://www.cyphra.dev/graph-orm)**

## License

MIT
