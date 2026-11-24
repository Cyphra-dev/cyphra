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
- `@cypher` fields on node types, relationship properties, `Query` and `Mutation`: scalar and
  node results, arguments (always passed as parameters), `this`, `$jwt`, `where` and `sort` on
  scalar fields, filters on node results, the READ rules of returned nodes.
- `@fulltext` queries (`score`, `where`, `sort`, `first` / `after`) on full-text indexes you
  create, as in v7.
- To-one relationships (`lab: Lab @relationship(…)`) with the smaller API v7 generates for them
  (no arguments, `lab: { … }` and `labConnection` filters, nested `create` and `delete` only), also
  in authorization rules (`node: { lab: { state: { eq: "PUBLISHED" } } }`).
- Unions of `@node` types: the root union query, relationships to unions (lists and connections,
  edge properties included), member-keyed `where` (`{ Movie: {…}, Book: {…} }`) and nested writes.
  One deliberate difference: a union `connect` / `disconnect` nested in another one applies its
  `where` (v7 7.6.8 ignores it and connects or disconnects every member node).
- Subscriptions (`@subscription`, `@subscriptionsAuthorization`, `where` on events) on Neo4j
  Change Data Capture, with `features.subscriptions` (Neo4j Enterprise or Aura with CDC enabled;
  run the server as a long-lived process, not a serverless function).
- Custom resolvers: the `resolvers` option (merged like `new Neo4jGraphQL({ typeDefs, resolvers })`)
  serves `Query` / `Mutation` fields without `@cypher`, object, input and union types without
  `@node` (passed through as written) and `@customResolver(requires)` fields (left out of the
  Cypher; the `requires` selection is always fetched for the parent). `context.jwt` and
  `context.executionContext` are set like v7. One deliberate difference: `@authentication` applies
  to every field served by resolvers (v7 7.6.8 applies it to the first two only).
- One Cypher statement per root field, in its own transaction. Needs Neo4j 5.23+.
- Not yet: interfaces, `@cypher` fields returning unions, `@vector`, `Point` /
  `Duration` and custom scalars (`makeSchema` throws `UnsupportedTypeDefsError`).

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
