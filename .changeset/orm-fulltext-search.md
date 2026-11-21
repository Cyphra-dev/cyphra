---
"@cyphra/runtime": minor
---

Add full-text search to the ORM client.

- `db.post.search({ index, query, mode, where, minScore, skip, take, select, include })` queries a `@@fulltext` index through `db.index.fulltext.queryNodes` and returns the matching nodes, most relevant first, each with a `$score` (Lucene's relevance score). It exists only on models with a `@@fulltext` attribute, and `index` only accepts that model's index names.
- `query` is Lucene query syntax by default (`mode: "lucene"`); `mode: "terms"` and `mode: "phrase"` escape it to search plain words or a phrase. The new `escapeLucene(text)` helper escapes user input for queries you build yourself. A blank query returns `[]`.
- `where` and `minScore` filter the hits in the same statement, before `skip` / `take`; full-text queries return every match, so a filtered search never comes back short. Works in `$transaction`, where the index sees the transaction's own writes. The new `SearchArgs`, `SearchMode`, `SearchResult` and `FulltextIndexNames` types are exported.
