# @cyphra/provider-neo4j

Neo4j **Bolt** implementation for Cyphra: **`CyphraClient`** on top of the official **`neo4j-driver`**, plus **`CyphraNeo4j`** for adapter-style construction.

Most applications import **`CyphraClient`** from **`cyphra`** or **`@cyphra/runtime`**; this package is the concrete driver behind those entry points.

## Install

```bash
npm install @cyphra/provider-neo4j
```

Usually you do **not** need this package directly if you already depend on **`cyphra`** or **`@cyphra/runtime`**.

## Usage

```ts
import { CyphraClient, CyphraNeo4j } from "@cyphra/provider-neo4j";

const client = new CyphraClient({
  adapter: new CyphraNeo4j({
    uri: process.env.NEO4J_URI!,
    user: process.env.NEO4J_USER!,
    password: process.env.NEO4J_PASSWORD!,
    database: process.env.NEO4J_DATABASE,
  }),
});
```

Pair with **`@cyphra/query`** (`cypher`, `CompiledCypher`) for parameterized Cypher.

## Neo4j driver parity

The package tracks **neo4j-driver** 5.x capabilities in code via **`NEO4J_DRIVER_ADAPTER_COVERAGE`** (`@cyphra/provider-neo4j` / `@cyphra/runtime`). Use it to see what is wrapped first-class (e.g. `sessionRead`, `executeCompiledQuery`, `verifyConnectivity`) vs. **passthrough** (`session` with full `SessionConfig`, raw **`Driver`**). A local mirror of the upstream driver repo may live under **`tmp/neo4j-javascript-driver`** for review; runtime still depends on the published **`neo4j-driver`** package.

## Documentation

**[cyphra.dev](https://www.cyphra.dev)** — client, configuration, providers.

## License

MIT
