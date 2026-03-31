# cyphra

Single **npm** package for the Cyphra stack: **`.cyphra`** schema parsing, **parameterized Cypher** helpers, **Neo4j** client (`CyphraClient` + `CyphraNeo4j` adapter), **ORM-style** helpers, **migrations**, and the **`cyphra`** CLI.

## Install

```bash
npm install cyphra
```

You get a **`bin`** entry, so `npx cyphra`, `pnpm exec cyphra`, or `node_modules/.bin/cyphra` work when `cyphra` is a direct dependency.

## What’s inside

| Area        | Role                                                     |
| ----------- | -------------------------------------------------------- |
| **Schema**  | Parse & validate `.cyphra`, schema print and DDL helpers |
| **Query**   | `cypher` tag, `SelectQuery`, write/batch compilers       |
| **ORM**     | `createNodeCrud`, traversals, batch write helper         |
| **Runtime** | `CyphraClient`, sessions, transactions, Neo4j Bolt       |
| **Migrate** | `defineMigration`, `push`, tracked migrations            |
| **CLI**     | `init`, `validate`, `db pull`, `migrate`, `push`, …      |

Smaller installs: depend on **`@cyphra/schema`**, **`@cyphra/query`**, etc., instead of this meta-package.

## `CyphraClient` here vs `@cyphra/runtime`

When you import **`CyphraClient` from `cyphra`**, you get a subclass that adds a lazy **`.orm`** property: Prisma-style delegates (`posts.create`, `findMany`, …) built from the **`schema`** path in **`cyphra.config.ts`** / **`cyphra.json`**. That path is resolved with **`loadConfigSync`** (Node + filesystem).

- Use **`projectRoot`** in the constructor if the app cwd is not the folder that contains `cyphra.config.ts`.
- Import **`CyphraClient` from `@cyphra/runtime`** when you only need Bolt (no ORM, no config-driven schema) — for example library code that must stay free of `fs`.

## Config shape (`defineCyphraConfig`)

Paths are relative to the project root. **`migrations`** may be a string or **`{ path: string }`**. Optional **`datasource`** (with **`provider`**) matches a Prisma-like layout; you can still wire **`CyphraNeo4j`** with env vars in application code.

```ts
import { CyphraClient, CyphraNeo4j, defineCyphraConfig } from "cyphra";

export default defineCyphraConfig({
  schema: "./schema.cyphra",
  datasource: { provider: "neo4j" },
  migrations: { path: "./migrations" },
});
```

```ts
import { CyphraClient, CyphraNeo4j } from "cyphra";

// Plain Node: load .env with `import "dotenv/config"` if you add the `dotenv` package.
// Next.js: put NEO4J_* in `.env.local` — no `dotenv` import needed.
const cyphra = new CyphraClient({
  adapter: new CyphraNeo4j({
    uri: process.env.NEO4J_URI!,
    user: process.env.NEO4J_USER!,
    password: process.env.NEO4J_PASSWORD!,
    database: process.env.NEO4J_DATABASE,
  }),
});

await cyphra.orm.posts.create({ data: { title: "Hi", slug: "hi" } });
```

**`loadConfig`** (async) and **`loadConfigSync`** are re-exported from `@cyphra/config` for tooling and tests.

Full guides: **[cyphra.dev](https://www.cyphra.dev)**.

## License

MIT
