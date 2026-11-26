---
"@cyphra/graphql": minor
---

`compat.v7` runs more requests on the shared engine, with the same results: `single` relationship filters, and reads and root mutations of types with `@authorization`. The rules are applied where v7 applies them (root nodes, nested relationships and connections, update and delete targets); requests whose `validate` rules may fail, or whose rules the engine cannot evaluate exactly like v7, stay on the compat compiler, as do types with `@authentication`. With `client`, the client's `query` events and spans now name the engine operation (`findMany`, `updateMany`, …) for these requests too.
