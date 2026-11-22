---
"@cyphra/graphql": minor
---

GraphQL subscriptions on Neo4j Change Data Capture, as in `@neo4j/graphql` v7: `@subscription`
types get `<type>Created`, `<type>Updated` and `<type>Deleted` fields with a `where` argument,
`@subscriptionsAuthorization` filters events and `@authentication(operations: [SUBSCRIBE])` checks
subscribers. Enable them with `features.subscriptions` (`true`, options such as `pollTime` and
`onlyGraphQLEvents`, or a `CDCSubscriptionsEngine`, also exported as
`compat.v7.Neo4jGraphQLSubscriptionsCDCEngine`). They need Neo4j Enterprise or Aura with CDC
enabled; on other databases subscribing fails with a clear error.
