---
"@cyphra/runtime": minor
---

Client extensions: `db.$extends({ query, result, model, client })` returns a new, fully typed client with query hooks around operations (per model, `$allOperations`, `$allModels`; they can change arguments and results), computed fields (`needs` + `compute`, added to result types, selectable, applied on nested relations, interfaces, traversals, paths and vector / full-text search), custom model methods (`this` is the extended delegate; `getExtensionContext`) and client members. Extensions compose, and `$transaction` on an extended client hands an extended transaction client.
