---
"@cyphra/graphql": patch
---

`compat.v7` runs `single` relationship filters (`actors: { single: … }`, `actors_SINGLE`, `actorsConnection: { single: … }`) on the shared engine, as a `_count` of the matching related nodes equal to 1, with the same results.
