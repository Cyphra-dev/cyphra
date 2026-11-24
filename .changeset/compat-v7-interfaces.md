---
"@cyphra/graphql": minor
---

`compat.v7.makeSchema` serves interfaces with `@neo4j/graphql` 7 semantics: the exact v7 schema
(interface types, `${Interface}Implementation` and the `typename` filter, implementation-keyed
create inputs, the interface's connection types on `@declareRelationship` fields, edge inputs keyed
by properties type), root `learningActivities` / `learningActivitiesConnection` queries with sorting,
pagination and `aggregate`, relationships to interfaces, filters through them, nested `create`,
`connect`, `update`, `disconnect` and `delete`, and each implementation's `@authorization`. Like v7,
interfaces add no label: a node belongs to the interface when it has the labels of one
implementation. `@query`, `@plural`, `@limit` and the field configuration directives work on
interfaces. Queries v7 7.6.8 fails on (interface aggregates with `@authorization` rules,
`count { edges }` on interface connections, `typename` in nested filters) are served.
