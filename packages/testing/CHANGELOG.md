# @cyphra/testing

## 0.22.0

### Patch Changes

- Updated dependencies [6f0644f]
  - @cyphra/runtime@0.22.0
  - @cyphra/migrator@0.22.0
  - @cyphra/schema@0.22.0

## 0.21.0

### Patch Changes

- Updated dependencies [5b60cb4]
- Updated dependencies [66bc969]
  - @cyphra/runtime@0.21.0
  - @cyphra/migrator@0.21.0
  - @cyphra/schema@0.21.0

## 0.20.1

### Patch Changes

- @cyphra/migrator@0.20.1
- @cyphra/runtime@0.20.1
- @cyphra/schema@0.20.1

## 0.20.0

### Patch Changes

- @cyphra/migrator@0.20.0
- @cyphra/runtime@0.20.0
- @cyphra/schema@0.20.0

## 0.19.0

### Patch Changes

- @cyphra/migrator@0.19.0
- @cyphra/runtime@0.19.0
- @cyphra/schema@0.19.0

## 0.18.0

### Minor Changes

- 3ba3747: New package `@cyphra/testing`: test helpers for apps on Cyphra. `startDatabase()` runs Neo4j,
  Memgraph or FalkorDB in Docker with Testcontainers; `applySchema()` runs the migrations and creates
  the schema's constraints and indexes; `withRollback()` (a transaction that is always rolled back)
  and `wipeDatabase()` isolate tests; `defineFactory()` / `factoriesFor()` build typed records for the
  generated models, with sequences and relation helpers (`nested`, `connect`, lazy fields).
  `createTestDatabase()` wires it into any runner's hooks (Vitest, Jest, `node:test`), and a Vitest
  global setup can share one container across test files.

### Patch Changes

- Updated dependencies [27bfd81]
  - @cyphra/runtime@0.18.0
  - @cyphra/migrator@0.18.0
  - @cyphra/schema@0.18.0
