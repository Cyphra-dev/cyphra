---
"@cyphra/graphql": minor
---

`native.makeSchema` / `native.printSchema` accept an API whose only `Query` fields come from `config.extend` (every generated read off, `extend type Query { … }`). The "API has no root field" check now runs after `extend` is merged.
