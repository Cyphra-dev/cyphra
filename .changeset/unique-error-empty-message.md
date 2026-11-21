---
"@cyphra/runtime": patch
---

`UniqueConstraintError` no longer reads "Unique constraint failed: undefined" when the server reports a uniqueness GQL status without a message: it says "Unique constraint failed (GQL status 22N79): a node or relationship with the same value already exists."
