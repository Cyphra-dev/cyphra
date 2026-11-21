---
"@cyphra/runtime": minor
---

Add `UniqueConstraintError` (a `CyphraError`): a write that duplicates an `@id`, `@unique`, `@@unique` or relationship `@unique` value now throws it instead of Neo4j's raw `Neo.ClientError.Schema.ConstraintValidationFailed` error, on Bolt (neo4j-driver 5 and 6) and on the HTTP transport. It has `model` (the model that declares the constraint, an interface for a constraint declared on one), `fields`, `constraint` (the name `cyphra push` / migrations give it), `code`, `gqlStatus` and the original error as `cause`; its message never contains the duplicate value. Every ORM write maps it (`create`, `createMany`, `update`, `updateMany`, `upsert`, nested `create`, `$edge` data, `$cypher`, inside and around `$transaction`); the statement's `error` event still carries the Neo4j code, and `db.$client` / `@cyphra/graphql` errors are unchanged. `parseUniqueViolation` reads the label and properties from Neo4j's message.
