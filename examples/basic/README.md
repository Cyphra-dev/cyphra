# Cyphra example — basic

Small Node script that uses **`@cyphra/schema`**, **`@cyphra/query`**, and **`@cyphra/runtime`**:

1. Parses `schema.cyphra` and prints a canonical copy.
2. Builds parameterized Cypher with the **`cypher`** template tag.
3. Builds the same shape with **`SelectQuery`**.
4. If `NEO4J_*` env vars are set, runs `RETURN 1` via **`CyphraClient.queryRecords`**.

## Run

From the **repository root** (after `pnpm install`):

```bash
pnpm example:basic
```

Or from this folder:

```bash
pnpm start
```

## Neo4j (optional)

Copy `.env.example` to `.env` and fill values, or export variables. Without them, the demo stops after printing compiled Cypher.

## Prerequisite

Workspace packages must be built once so `dist/` exists:

```bash
pnpm -r --filter './packages/*' run build
```
