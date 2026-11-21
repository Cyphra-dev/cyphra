---
"@cyphra/better-auth": minor
---

Add the `numberFields` option (`cyphraAdapter`, `authSchema`, `neo4jBetterAuthMigration`) to store chosen Better Auth `number` / `number[]` fields as `Float` instead of `Int`, so they accept fractional values; `createSchema` writes `Float` for them, and integers already stored in a field switched to `float` keep reading and matching unchanged. `sortBy` on a foreign key (`userId`) is now supported: it orders by the referenced field of the related node, through the edge.
