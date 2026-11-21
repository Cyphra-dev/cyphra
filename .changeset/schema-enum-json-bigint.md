---
"@cyphra/schema": minor
"@cyphra/runtime": minor
"@cyphra/migrator": minor
"cyphra": minor
---

Schema: `enum Role { ADMIN USER }` declarations, and the `Json` and `BigInt` scalar types.

- **Enums** are used as field types (`role Role @default(USER)`, `Role?`, `Role[]`, also on
  relationship properties) and stored as strings. `cyphra generate` emits a const object and a
  union type per enum (`Role.ADMIN`, `type Role = "ADMIN" | "USER"`). Every write (nested creates,
  `createMany`, `upsert`, `$edge` included) rejects a value outside the enum, and filters
  (`equals`, `not`, `in`, `notIn`, list operators) are typed to it. Migrations warn when a value is
  removed from an enum, with a query that finds the nodes still holding it.
- **`Json`** fields take and return any `JsonValue` (exported type), stored as the value's JSON text.
  They filter on `null`, `{ equals }` and `{ not }` only, and take a JSON-text default
  (`@default("{}")`).
- **`BigInt`** fields are Neo4j 64-bit integers read and written as JS `bigint`, exact over the whole
  range (-2^63 to 2^63-1), with either `neo4j-driver` major. They filter (`lt`, `gt`, `in`, …), sort,
  take `{ increment: 1n }` updates and `@default(0)` literals (every digit kept), and aggregate:
  `_sum`, `_min` and `_max` are `bigint`, `_avg` a `number`.

`createMany` now rejects its promise on invalid data instead of throwing synchronously.
