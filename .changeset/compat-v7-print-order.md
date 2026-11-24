---
"@cyphra/graphql": patch
---

`compat.v7.makeSchema` returns its schema in `@neo4j/graphql` 7's order, so `printSchema` output is
byte-identical to v7's: root types first, then scalars, enums, unions, interfaces, object types and
input types (each sorted by name, like v7), and every field, argument, input field and enum value
where v7 puts it (`moviesConnection(first, after, where, sort)` before
`movies(where, limit, offset, sort)`, `OR` / `AND` / `NOT` after the attribute filters, …). A
printed contract committed by a v7 application does not change when it switches.
