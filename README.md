# Cyphra

**Cyphra** is a TypeScript toolkit for [Neo4j](https://neo4j.com/): a **`.cyphra`** schema language, **Cypher-first** queries (parameterized templates and a small builder), **migrations**, and a **CLI**.

## Install

```bash
npm install cyphra
# or: pnpm add cyphra / yarn add cyphra
```

The **`cyphra`** package gives you the libraries and the **`cyphra`** CLI in one dependency. You can also install scoped packages only (for example `@cyphra/schema`, `@cyphra/query`) if you want a smaller install.

Typical client setup:

```ts
import { CyphraClient, CyphraNeo4j, cypher } from "cyphra";

const client = new CyphraClient({
  adapter: new CyphraNeo4j({
    uri: process.env.NEO4J_URI!,
    user: process.env.NEO4J_USER!,
    password: process.env.NEO4J_PASSWORD!,
    database: process.env.NEO4J_DATABASE,
  }),
});
```

CLI configuration can live in **`cyphra.config.ts`** or **`cyphra.json`**.
Recommended flow: **schema -> validate -> push/migrate -> query with `orm` or `query`**.

## Documentation

**[www.cyphra.dev](https://www.cyphra.dev)** — getting started, schema, queries, client, migrations, CLI.

## VS Code

**[Cyphra on the Marketplace](https://marketplace.visualstudio.com/items?itemName=Cyphra.cyphra-vscode)** — syntax highlighting for `.cyphra` files.

## Repository

Source, issue tracker, and **MIT** license: **[github.com/cyphra-dev/cyphra](https://github.com/cyphra-dev/cyphra)**.

This repo also contains example apps under **`examples/`** (useful if you clone the project; they are not published to npm).

## Contributing

Clone the monorepo and see **[CONTRIBUTING.md](./CONTRIBUTING.md)** for setup, tests, changesets, and releases.

## Security

See **[SECURITY.md](./SECURITY.md)** for reporting vulnerabilities.
