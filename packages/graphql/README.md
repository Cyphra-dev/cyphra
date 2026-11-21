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
  nested relationships and connections with edge properties, connection `aggregate` selections and
  aggregation filters.
- Mutations: `create`, `update`, `delete` with `info` counters, nested `create` / `connect` /
  `disconnect` / `update` / `delete` with edge properties, every update operator (deprecated forms
  included), `@id`, `@timestamp` and `@default`. No APOC needed.
- `@authentication` / `@authorization` (type, field and `extend schema` level), `@jwt` and
  `@jwtClaim`: rules are compiled into the Cypher statement (filters in its `WHERE`, `validate`
  checks inside it, a failed check rolls the statement back), never applied in JavaScript.
- One Cypher statement per root field, in its own transaction. Needs Neo4j 5.23+.
- Not yet: `@cypher` fields (#75). They are in the schema and return a `Not implemented yet` error.

JWTs are verified like v7, with `features.authorization` and the request's `Authorization` header
as `token` in the context (a decoded `jwt` in the context is trusted as it is):

```ts
const schema = compat.v7.makeSchema({
  typeDefs,
  driver,
  features: { authorization: { key: process.env.JWT_SECRET! } }, // or { key: { url: jwksUrl } }
});
// GraphQL server context: ({ request }) => ({ token: request.headers.get("authorization") })
```

Read the [authorization docs](https://www.cyphra.dev/graphql#authentication-and-authorization) for
the v7 behaviours that matter for security (filters on fields the user cannot read, AGGREGATE vs
READ rules, relationship-only updates) and the few cases where Cyphra is stricter than v7.

Compatibility is measured against the real `@neo4j/graphql` by the suite in
[`compat/graphql`](https://github.com/Cyphra-dev/cyphra/tree/main/compat/graphql).

The package also contains `convertGraphQLTypeDefs`, the converter behind `cyphra import graphql`.
