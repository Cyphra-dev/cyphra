---
"@cyphra/cli": minor
"@cyphra/schema": minor
---

Zod generator: `"generators": { "zod": { "omitGenerated": true } }` (or `cyphra generate --zod-omit-generated`) leaves the fields Cyphra generates out of `<Model>CreateInputSchema` and `<Model>UpdateInputSchema`: an `@id` with a `@default`, and `now()`, `cuid()` and `uuid()` defaults. Public APIs no longer need `.omit({ id: true, createdAt: true })`. `isGeneratedField` is exported from `@cyphra/schema`.
