---
"@cyphra/query": patch
---

Move the fluent read API (`createFluentQueryRoot`, `MatchVar`, `FluentReadClient`, …) into `@cyphra/query` from the `cyphra` meta-package sources. `CyphraClient.query` behavior is unchanged; symbols remain re-exported from the `cyphra` entry via `export * from "@cyphra/query"`.
