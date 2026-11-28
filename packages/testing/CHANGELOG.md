# @cyphra/testing

## 0.32.0

### Patch Changes

- Updated dependencies [cba69f3]
- Updated dependencies [6d786ee]
- Updated dependencies [fd81ee5]
  - @cyphra/schema@0.32.0
  - @cyphra/migrator@0.32.0
  - @cyphra/runtime@0.32.0

## 0.31.0

### Patch Changes

- Updated dependencies [1abed04]
  - @cyphra/runtime@0.31.0
  - @cyphra/migrator@0.31.0
  - @cyphra/schema@0.31.0

## 0.30.0

### Patch Changes

- Updated dependencies [bd5c7ef]
  - @cyphra/runtime@0.30.0
  - @cyphra/migrator@0.30.0
  - @cyphra/schema@0.30.0

## 0.29.0

### Patch Changes

- Updated dependencies [7f2f123]
  - @cyphra/runtime@0.29.0
  - @cyphra/migrator@0.29.0
  - @cyphra/schema@0.29.0

## 0.28.0

### Patch Changes

- Updated dependencies [55a869b]
  - @cyphra/runtime@0.28.0
  - @cyphra/migrator@0.28.0
  - @cyphra/schema@0.28.0

## 0.27.0

### Patch Changes

- Updated dependencies [fd05388]
  - @cyphra/runtime@0.27.0
  - @cyphra/migrator@0.27.0
  - @cyphra/schema@0.27.0

## 0.26.0

### Patch Changes

- Updated dependencies [db04150]
  - @cyphra/runtime@0.26.0
  - @cyphra/migrator@0.26.0
  - @cyphra/schema@0.26.0

## 0.25.0

### Patch Changes

- Updated dependencies [1ac6f9d]
- Updated dependencies [942ebc0]
- Updated dependencies [1e0082e]
  - @cyphra/runtime@0.25.0
  - @cyphra/migrator@0.25.0
  - @cyphra/schema@0.25.0

## 0.24.0

### Patch Changes

- Updated dependencies [ca21801]
  - @cyphra/runtime@0.24.0
  - @cyphra/migrator@0.24.0
  - @cyphra/schema@0.24.0

## 0.23.0

### Patch Changes

- Updated dependencies [609a44c]
- Updated dependencies [5f36831]
  - @cyphra/runtime@0.23.0
  - @cyphra/migrator@0.23.0
  - @cyphra/schema@0.23.0

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
