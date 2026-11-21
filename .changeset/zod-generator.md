---
"@cyphra/schema": minor
"@cyphra/cli": minor
---

Zod schema generator: validate API input against the schema with [zod](https://zod.dev) (zod 4 and zod 3).

- **CLI**: with `"generators": { "zod": { "output": "./src/cyphra.zod.ts", "coerce": false, "import": "zod" } }` in `cyphra.json` (or `"zod": true`), `cyphra generate` also writes zod schemas; `--watch` and `cyphra dev --watch` regenerate them too. `cyphra generate --zod [output]` and `--zod-coerce` turn it on for one run or override the config.
- **Schemas**: for each node model `User`: `UserSchema` (the properties the client returns), `UserCreateInputSchema` (fields with a default, optional fields and lists may be left out) and `UserUpdateInputSchema` (every field optional); the same for each relationship model's edge properties; `RoleSchema` (`z.enum`) per enum. Relation fields are left out. What they parse type-checks as the client's `data`.
- **Checks**: the validation rules with the runtime's semantics and messages (`@length` in code points, `@url` http(s) only, `@nonEmpty` on trimmed strings, inclusive `@min` / `@max`, `Date` bounds on the UTC day, `@regex` flags), and the types: integer `Int`, 64-bit `BigInt`, `Date`s, temporal ISO 8601 text checked as the runtime parses it, `Point` / `CartesianPoint` objects, `Vector(N)` length, JSON values. `coerce` reads ISO 8601 strings as `Date`s and decimal strings as `bigint`s.
- **API**: `renderZodSource(doc, { coerce, zodImport })` and `renderZodFromModel(model, options)` in `@cyphra/schema`.
