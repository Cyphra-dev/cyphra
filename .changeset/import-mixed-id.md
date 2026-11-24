---
"@cyphra/graphql": patch
---

`cyphra import graphql`: a shared label or GraphQL interface whose implementations declare the same id differently (`id: ID! @id` on one, a plain `id: ID!` on another) is now converted to an interface instead of `@@labels` (which also dropped every relationship to the interface, and made `--id-fields Interface.id` fail with "the label is not an interface"). The interface declares the id `@id`, with `@default(uuid())` when one implementation generated its ids, and the report explains the decision (#252).
