---
"@cyphra/cli": minor
---

`cyphra studio` uses the configured dialect: the `"dialect"` of `cyphra.json`, or the one detected from the server when it sets none, so it browses and edits Memgraph databases. The studio meta carries `dialect` and marks fields the database cannot store (`unsupported`, e.g. `Time` on Memgraph): the UI shows a Memgraph badge, makes those fields read-only and leaves them out of filters, and the API refuses to write them. `UnsupportedFeatureError`s and Memgraph client errors are answered with a 400 and the reason (`unsupported: { feature, dialect }`), and Memgraph errors that retrying cannot fix are raised at once instead of being retried.
