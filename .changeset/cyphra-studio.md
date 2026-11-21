---
"@cyphra/cli": minor
---

`cyphra studio`: a local data browser built from `schema.cyphra`. It serves a bundled web UI on
`127.0.0.1` (`--port`, `--host`, `--no-open`, `--read-only`) to browse node models, interfaces and
relationship models with counts, filter, sort and page, edit records with typed inputs (writes go
through the ORM, so validation rules and unique constraints apply), follow relations, preview
`onDelete` effects before a delete, and run raw Cypher (read transactions unless writes are allowed).
The API requires a per-session token (moved from the URL to an HttpOnly cookie) and a custom header,
and refuses foreign `Host` and `Origin` headers.
