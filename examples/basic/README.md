# Basic Cyphra example

Small **Node.js** script that shows how to:

1. Parse a **`.cyphra`** schema and print it canonically
2. Build **parameterized Cypher** with the **`cypher`** tag
3. Build the same idea with **`SelectQuery`**
4. Print schema integration hints and **DDL** lines (what `cyphra push` would apply)
5. Optionally run **`RETURN 1`** against Neo4j when **`NEO4J_*`** env vars are set

**Docs:** [cyphra.dev](https://www.cyphra.dev) · **Toolkit:** [`cyphra`](https://www.npmjs.com/package/cyphra) on npm

## Run (from a clone of the Cyphra repo)

This folder uses the workspace package **`cyphra`**. From the **repository root**:

```bash
pnpm install
pnpm build
pnpm example:basic
```

Or from **`examples/basic`**:

```bash
pnpm start
```

Build **`packages/*`** once so workspace dependencies expose `dist/`.

### Neo4j (optional)

Copy **`.env.example`** to **`.env`** or export **`NEO4J_URI`**, **`NEO4J_USER`**, **`NEO4J_PASSWORD`**. Without them, the script stops after printing compiled Cypher.

## Run your own copy with npm

Use **`npm install cyphra`**, copy **`schema.cyphra`** and the logic from **`src/main.ts`**, and run with **`tsx`** or compile with **TypeScript**. The APIs are the same as in this example.

## License

MIT (same as the Cyphra monorepo).
