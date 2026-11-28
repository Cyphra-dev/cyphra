---
"@cyphra/graphql": patch
---

`cyphra import graphql` keeps an interface (or a shared `@node(labels)` label) whose implementations declare a field alike but for its `@default` (`kind: String! @default(value: "lab")` on one, `"quiz"` on another): the field stays on each implementation with its own default, instead of the interface falling back to `@@labels` and dropping the relationships to it. The report now prints decorator arguments (`@default("lab")`, `@default(uuid())`), so differing defaults are visible.
