# @cyphra/better-auth

> Part of [Cyphra](https://www.cyphra.dev), the TypeScript ORM for Neo4j. **Better Auth:** [docs](https://www.cyphra.dev/better-auth)

A [Better Auth](https://www.better-auth.com) database adapter for Neo4j, built on the Cyphra ORM.
Users, sessions, accounts, verifications and plugin models are nodes in the same graph as your own
models, described by one `schema.cyphra` and migrated by `cyphra migrate`.

```bash
npm i @cyphra/better-auth better-auth cyphra
```

```ts
// auth.ts
import { betterAuth } from "better-auth";
import { cyphraAdapter } from "@cyphra/better-auth";
import { db } from "./db"; // your generated Cyphra client (createClient from cyphra.gen.ts)

export const auth = betterAuth({
  database: cyphraAdapter({ db }),
  emailAndPassword: { enabled: true },
});
```

Pass `{ client }` (a `CyphraClient`) instead of `{ db }` if you have no generated client yet.

```bash
npx @better-auth/cli generate   # adds the Better Auth models to schema.cyphra, keeps yours
npx cyphra migrate dev --name better-auth
npx cyphra generate
```

- The schema is derived from your Better Auth configuration (plugins included) at runtime.
- Labels are the model names in PascalCase: `User`, `Session`, `Account`, `Verification`.
- Foreign keys are edges, not properties: `Session.userId` is `(User)-[:HAS_SESSION]->(Session)`,
  exposed in the typed client as `session.user` and `user.sessions`.
- `number` fields are `Int`; list the ones that hold fractions in
  `cyphraAdapter({ db, numberFields: { wallet: { balance: "float" } } })` to store them as `Float`.
  Sorting by a foreign key (`sortBy: { field: "userId" }`) orders by the related node's id.
- Dates are Neo4j `DateTime` values; `references.onDelete` (`cascade`, `restrict`, `set null`) is
  applied in the same transaction; `consumeOne` and `incrementOne` are race-safe.
- Passes Better Auth's adapter conformance suites (normal, case-insensitive, transactions, joins,
  uuid, auth flow).

Coming from `neo4j-better-auth`? See
[Migrating from neo4j-better-auth](https://www.cyphra.dev/better-auth#migrating-from-neo4j-better-auth).

## License

MIT
