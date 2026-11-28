---
"@cyphra/graphql": patch
---

`cyphra graphql compare` (`migrate.compareResults`) compares errors on `extensions.code`, `message` and `path` (the v7 path mapped to the native shape), not only their number: an `UNAUTHENTICATED` / `FORBIDDEN` mismatch with the same message is now a difference. A v7 error that nulls the whole `data` (a non-null root field) against a `null` native root field is reported as a known difference. New exported type `GraphQLErrorLike`.
