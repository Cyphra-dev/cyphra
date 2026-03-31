# @cyphra/migrator

Versioned **Neo4j** migrations and **schema push** (constraints and indexes from your `.cyphra` model).

## Install

```bash
npm install @cyphra/migrator
```

Usually consumed via **`cyphra`** together with **`CyphraClient`**.

## Example

```ts
import { defineMigration } from "@cyphra/migrator";

export default defineMigration({
  name: "001_example",
  async up({ db }) {
    await db.run`RETURN 1`;
  },
});
```

Applied migrations are recorded as **`__CyphraMigration`** nodes in the graph.

## Documentation

**[cyphra.dev — Migrations](https://www.cyphra.dev/migrations)**

## License

MIT
