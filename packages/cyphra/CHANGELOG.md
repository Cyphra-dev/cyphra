# cyphra

## Unreleased (beta)

### Minor Changes

- **`query`** and **`orm`** namespace exports on the main entry; subpath exports **`cyphra/query`** and **`cyphra/orm`** for tree-shaking.
- **`loadCyphraWorkspace`** and **`loadConfig`** re-exported for the schema → config → migrate → runtime story.
- Depends on new **`@cyphra/config`** (shared with **`@cyphra/cli`**).
- Dropped support for **`cyphra generate`** and **`cyphra.gen.ts`** in the stack defaults; config now focuses on schema + migrations + provider.

### Patch Changes

- @cyphra/orm: **`createSchemaClient`** gains nested **`connect`** on OUT to-one relations; **`findMany`** / **`findFirst`** support optional **`include`**, **`orderBy`**, **`skip`** / **`take`** (backed by **`compileRootOptionalOutgoingSelect`** with **`skip`**).
- @cyphra/query: **`compileRootOptionalOutgoingSelect`** accepts **`skip`**.

Breaking changes are acceptable during beta; update imports and regenerate **`dist/`** after pulling (`pnpm build` or filter builds for touched packages).

## 0.2.0

### Minor Changes

- ORM package (`@cyphra/orm`), Neo4j driver provider, extended query DSL and migrations, documentation site, Next.js example, CLI (`db pull`, `schema add`), and VS Code extension packaging in CI.

### Patch Changes

- @cyphra/cli@0.2.0
- @cyphra/core@0.2.0
- @cyphra/migrator@0.2.0
- @cyphra/orm@0.2.0
- @cyphra/provider-neo4j@0.2.0
- @cyphra/query@0.2.0
- @cyphra/runtime@0.2.0
- @cyphra/schema@0.2.0

## 0.1.0

### Patch Changes

- Updated dependencies [e16a08f]
  - @cyphra/schema@0.1.0
  - @cyphra/query@0.1.0
  - @cyphra/runtime@0.1.0
  - @cyphra/migrator@0.1.0
  - @cyphra/cli@0.1.0
