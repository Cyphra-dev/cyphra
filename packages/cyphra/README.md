# cyphra

One install for the full Cyphra stack: **schema** (`.cyphra` DSL), **query** (`cypher` tag + `SelectQuery`), **runtime** (`CyphraClient`), and **migrator** (push DDL, versioned migrations).

```bash
pnpm add cyphra
# or: npm install cyphra
```

This package depends on `@cyphra/schema`, `@cyphra/query`, `@cyphra/runtime`, and `@cyphra/migrator`. You can import everything from `cyphra` or continue to use subpackage imports if you prefer tree-shaking hints per module.

```ts
import {
  parseSchema,
  cypher,
  CyphraClient,
  defineMigration,
  constraintStatementsFromSchema,
} from "cyphra";
```

The **CLI** is published separately as `@cyphra/cli` (dev dependency recommended).

```bash
pnpm add -D @cyphra/cli
```
