---
"@cyphra/graphql": minor
---

Native GraphQL API: writes (#243). `defineGraphQL` turns them on per model, by group
(`operations: { create, update, delete }`, `true` or a list; still off by default), and serves
`<model>Create`, `CreateMany`, `Update`, `UpdateMany`, `Upsert`, `Delete` and `DeleteMany` as
`Mutation` root fields, each one client operation compiled to one statement. Mutations return
records (the deleted one for `delete`); batch mutations return `<Model>Batch { count nodes }`,
loading `nodes` only when selected.

- Nested `create` / `connect` / `disconnect` / `set`, with inputs per relation side
  (`UserCreateWithoutPostsInput`, `PostCreateManyWithoutAuthorRelation`, `UserConnectFollows`).
  `connect` is a `MERGE`: connecting a linked pair keeps one edge and updates its `_edge`. A model
  whose `create` is off has no nested create either.
- Scalar updates take plain values (`null` removes the property) and numeric operators in `_ops`
  (also on `_edge` of `connect` / `set`); a value and an operator on one field is `BAD_USER_INPUT`.
- Field toggles `create` / `update` remove fields from the write inputs (`{ read: false, create:
true }` is a write-only field); `makeSchema` refuses a creatable model with a required field that
  cannot be set.
- Validation issues (`extensions.issues`) carry GraphQL argument paths
  (`["data", "posts", "create", 1, "title"]`, `["data", "_ops", "loginCount"]`); unique constraint
  violations are `UNIQUE_CONSTRAINT`, missing targets `NOT_FOUND`.
- `mutationTransaction: "request"` runs every root field of a mutation operation in one write
  transaction (default: one per root field).
