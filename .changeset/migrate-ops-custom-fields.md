---
"@cyphra/graphql": patch
"@cyphra/cli": patch
---

`cyphra graphql migrate-operations` (`migrate.translateDocument`) leaves a document that only uses custom fields (served by `extend` in the native API) byte-identical and reports it as `unchanged` (new `DocumentStatus`), instead of "translated" and rewrapped; `--check` no longer fails on it. In a translated document, an operation whose translation is itself keeps its source text too.
