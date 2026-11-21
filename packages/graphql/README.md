# @cyphra/graphql

> Part of [Cyphra](https://www.cyphra.dev), the TypeScript ORM for Neo4j. **GraphQL:** [docs](https://www.cyphra.dev/graphql)

Serves the GraphQL API that `@neo4j/graphql` v7 generates from your type definitions (same types,
fields, filters and results) on the Cyphra runtime, so frontends switch without changing their
queries.

```bash
npm i @cyphra/graphql graphql neo4j-driver
```

```ts
import { compat } from "@cyphra/graphql";

// Before: await new Neo4jGraphQL({ typeDefs, driver }).getSchema()
const schema = compat.v7.makeSchema({ typeDefs, driver });
```

Serve `schema` with GraphQL Yoga, Apollo Server or any GraphQL server.

Status (early release):

- The full v7 schema is generated; its printed SDL is identical to `@neo4j/graphql` 7.6.8.
- Read API: list and connection queries, filters, sorting, `limit` / `offset`, cursor pagination,
  nested relationships and connections with edge properties. One Cypher statement per root field.
- Not yet: aggregations (#72), mutations (#73), `@authentication` / `@authorization` (#74) and
  `@cypher` fields (#75). They are in the schema and return a `Not implemented yet` error.

Compatibility is measured against the real `@neo4j/graphql` by the suite in
[`compat/graphql`](https://github.com/Cyphra-dev/cyphra/tree/main/compat/graphql).

The package also contains `convertGraphQLTypeDefs`, the converter behind `cyphra import graphql`.
