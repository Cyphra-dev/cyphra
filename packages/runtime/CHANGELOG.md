# @cyphra/runtime

## 0.7.0

### Minor Changes

- fc22aac: Add vector similarity search to the ORM client.

  - `db.chunk.findSimilar({ field, vector, k, where, minScore, select, include })` returns the `k` nodes most similar to `vector`, best first, each with a `$score` (the index's score in `[0, 1]`), through `db.index.vector.queryNodes` (Neo4j 5.15+). It exists only on models with a `Vector(N) @vectorIndex` field, and `field` only accepts those fields; the vector length is checked at runtime.
  - With `where`, the search over-fetches `candidates` neighbours (default `max(10 × k, 100)`), filters them in the same statement and widens (×4) until `k` rows match, the index is exhausted, scores fall below `minScore`, or `maxCandidates` is reached. `exact: true` skips the index and ranks the nodes matching `where` with `vector.similarity.*` (Neo4j 5.18+), for selective filters.
  - Vector fields are written as float lists with their length checked on `create`, `update`, `upsert` and `createMany`, filter only on `null`, and cannot be sorted. Works in `$transaction`. The new `FindSimilarArgs`, `SimilarResult`, `VectorKeys` and `VectorIndexKeys` types are exported.

- 1e3c799: Add full-text search to the ORM client.

  - `db.post.search({ index, query, mode, where, minScore, skip, take, select, include })` queries a `@@fulltext` index through `db.index.fulltext.queryNodes` and returns the matching nodes, most relevant first, each with a `$score` (Lucene's relevance score). It exists only on models with a `@@fulltext` attribute, and `index` only accepts that model's index names.
  - `query` is Lucene query syntax by default (`mode: "lucene"`); `mode: "terms"` and `mode: "phrase"` escape it to search plain words or a phrase. The new `escapeLucene(text)` helper escapes user input for queries you build yourself. A blank query returns `[]`.
  - `where` and `minScore` filter the hits in the same statement, before `skip` / `take`; full-text queries return every match, so a filtered search never comes back short. Works in `$transaction`, where the index sees the transaction's own writes. The new `SearchArgs`, `SearchMode`, `SearchResult` and `FulltextIndexNames` types are exported.

### Patch Changes

- Updated dependencies [1e3c799]
- Updated dependencies [fc22aac]
  - @cyphra/schema@0.7.0
  - @cyphra/query@0.7.0

## 0.6.0

### Minor Changes

- 4832219: Add relation counts to the ORM client, with Prisma-compatible shapes typed from your schema.

  - `include: { _count: true }` counts every to-many relation; `_count: { select: { posts: true, comments: { where: { approved: true } } } }` counts the listed ones, with an optional filter on the related node (relation filters included). Works under `select` and `include`, inside included relations at any depth, and in the results of `find*`, `create`, `update`, `upsert` and `delete`. The result has a `_count: { posts: number, … }` key typed from exactly what you ask for.
  - `orderBy: { posts: { _count: "desc" } }` sorts by the number of related nodes, at the top level and inside included relations.
  - Counts compile to `COUNT {}` subqueries in the same statement. As in Prisma, to-one relations cannot be counted.

- 3f2c13d: Add shortest-path queries to the ORM client.

  - `db.user.shortestPath({ from, to, via, maxDepth, direction, where, edgeWhere, select, include })` returns one shortest path between the nodes matching `from` and `to` along self-relations, or `null`; `db.user.allShortestPaths({ …, take })` returns every path of the minimal length. Both compile to one statement with a GQL shortest-path selector (`SHORTEST 1` / `ALL SHORTEST`), so they need Neo4j 5.21 or later.
  - `maxDepth` is required and capped by the client option `maxTraversalDepth` (default 10). `where` (intermediate nodes) and `edgeWhere` (every edge) are applied before the shortest path is picked. When `from` / `to` match several nodes, the overall shortest paths over every pair are returned; a node matching both gives a zero-hop path.
  - Results are typed paths (`{ nodes, edges }`): nodes are shaped by `select` / `include`, edge properties are typed from the `relationship { … }` model. The new `ShortestPathArgs` and `ShortestPathResult` types are exported.

- 879de50: Add variable-length traversals and typed path results to the ORM client.

  - `db.user.traverse({ from, via, depth: { min?, max }, where, edgeWhere, distinct, direction, select, include, orderBy, skip, take })` follows one or more self-relations (e.g. `following`) for `min..max` hops and returns the reached nodes, in one statement compiled to a quantified path pattern (Neo4j 5.9+). `depth.max` is required and capped by the new client option `maxTraversalDepth` (default 10). Each reached node is returned once by default; paths that loop back to their start node are skipped.
  - `edgeWhere` filters every edge of the path on the properties of its `relationship { … }` model, typed from the schema.
  - `returnPaths: true` returns `{ node, path }`, where `path` is `{ nodes, edges }`: the path's nodes (scalar fields) and its edges (`type`, `direction`, typed `properties`). The exported `Path`, `PathEdge` and `ModelPath` types describe them. Paths are decoded from plain maps, so they work with `neo4j-driver` 5 and 6.

### Patch Changes

- @cyphra/query@0.6.0
- @cyphra/schema@0.6.0

## 0.5.0

### Minor Changes

- a8be483: Support `neo4j-driver` 6 alongside 5.28 (`^5.28.3 || ^6.0.0`).

  - `@cyphra/runtime`, `@cyphra/migrator` and `@cyphra/better-auth` now declare `neo4j-driver` as a peer dependency, so your app and Cyphra share a single driver. `cyphra` and `@cyphra/cli` depend on it directly with the same range, so `npm i cyphra` still works on its own. If you install the `@cyphra/*` subpackages with a package manager that does not install peer dependencies (Yarn), add `neo4j-driver` yourself.
  - `new CyphraClient({ driver })` and `createClient({ driver })` reuse a `Driver` your app already created (5.28+ or 6.x, even from another copy of the package). Cyphra does not close a driver you pass in.

- e5851e2: Add `aggregate` and `groupBy` to the ORM client, with Prisma-compatible shapes typed from your schema.

  - `db.post.aggregate({ where, _count, _sum, _avg, _min, _max })` returns exactly the aggregates you ask for. `_sum` / `_avg` take `Int` and `Float` fields, `_min` / `_max` also `String`, `DateTime` and `Date`. Nulls are ignored; on an empty match counts are `0` and the other aggregates `null`.
  - `db.post.groupBy({ by: ["published"], having, orderBy, skip, take, … })` groups the matching nodes, with `having` and `orderBy` on aggregates (`{ views: { _avg: { gt: 10 } } }`, `{ _count: { id: "desc" } }`) and on the `by` fields. Fields of a to-one relation can be grouped on with `by: ["author.name"]` and come back as `{ author: { name } }`.
  - Each call compiles to one parameterised Cypher statement and works inside `$transaction`.

### Patch Changes

- @cyphra/query@0.5.0
- @cyphra/schema@0.5.0

## 0.4.0

### Minor Changes

- e1ad59f: New package `@cyphra/better-auth`: a Better Auth database adapter built on the Cyphra ORM, so auth data (users, sessions, accounts, verifications, plugin models) and your own models live in one typed graph with one schema and one migration system. The Cyphra schema is derived from your Better Auth configuration at runtime; foreign keys are stored as `HAS_*` edges; `npx @better-auth/cli generate` merges the auth models into `schema.cyphra` and keeps your own models and fields. Passes Better Auth's adapter conformance suites (normal, case-insensitive, transactions, joins, uuid, auth flow). Includes `neo4jBetterAuthMigration()` to convert data written by `neo4j-better-auth`.

  `@cyphra/runtime`: string filters accept `mode: "insensitive"` (Prisma-compatible) for case-insensitive `equals`, `not`, `in`, `notIn`, `contains`, `startsWith` and `endsWith`.

  `@cyphra/schema`: `cyphra generate` types a node without relations as `relations: Record<never, never>` instead of `{}`, which failed `@typescript-eslint/no-empty-object-type` in projects that lint the generated client.

### Patch Changes

- Updated dependencies [e1ad59f]
  - @cyphra/schema@0.4.0
  - @cyphra/query@0.4.0

## 0.3.0

### Minor Changes

- 232fbcc: ORM write correctness fixes and string range filters:

  - `upsert` now compiles to a single atomic `MERGE` on the unique key from `where` (`ON CREATE SET` the create data and schema defaults, `ON MATCH SET` the update), then runs nested relation writes of the branch it took in the same transaction. Concurrent upserts of one new key no longer fail with `ConstraintValidationFailed`; with the uniqueness constraint that `@id` / `@unique` generate (`cyphra push` or a migration) they yield exactly one node. The key never gets a generated default, `create` may not set the key to a different value than `where`, and extra `where` conditions are checked on an existing node before it is updated (a mismatch throws `CyphraError` and writes nothing).
  - `connect` (in `create`, `update`, `set` and `upsert`) now `MERGE`s the relationship instead of `CREATE`, so connecting an already linked pair keeps one edge. On typed edges, `$edge` plus defaults apply when the edge is created; an existing edge gets only the `$edge` properties passed. A to-one `connect` (e.g. `post.update({ author: { connect } })`) now deletes the previous edge in the same statement as the `MERGE`, with the node locked, so concurrent author changes leave one edge. Likewise, when the target's side of the relation is declared to-one (e.g. `user.posts` → `connect` on a post, with `Post.author User?`), the target's previous edge of that type is deleted in the same statement (the target is locked first, so concurrent connects leave one edge); many-to-many relations are unaffected. Edges duplicated by earlier versions are left in place.
  - `DateTime` values (writes, `@default(now())` and filter parameters) are always stored at UTC offset `Z` instead of the process's local offset, so `equals` / `in` match the same instant regardless of the server's `TZ`. Values written by earlier versions with a non-zero offset still read back correctly, but exact-instant comparisons against them do not match; see the docs for a one-off Cypher to normalize them.
  - Typed filters: `lt` / `lte` / `gt` / `gte` on `String` fields (lexicographic), e.g. for keyset pagination on an `id` tie-breaker.

### Patch Changes

- @cyphra/query@0.3.0
- @cyphra/schema@0.3.0

## 0.2.2

### Patch Changes

- e7419f9: Package metadata: npm pages now link to www.cyphra.dev (instead of the old cyphra-doc.vercel.app) and describe Cyphra as the TypeScript ORM for Neo4j, with matching keywords.
- Updated dependencies [e7419f9]
  - @cyphra/schema@0.2.2
  - @cyphra/query@0.2.2

## 0.2.1

### Patch Changes

- @cyphra/query@0.2.1
- @cyphra/schema@0.2.1

## 0.2.0

### Minor Changes

- d836db9: Typed ORM client generated from `.cyphra` schemas.

  - `cyphra generate` now emits model types, a `CyphraTypeMap` and a typed `createClient()` alongside the existing label / relationship constants (`runtimeImport` in `cyphra.json` picks the import, default `"cyphra"`).
  - New ORM runtime: `findMany`, `findFirst`, `findUnique(OrThrow)`, `count`, `create` (nested `create` / `connect`), `createMany`, `update` (number ops, `connect` / `disconnect` / `set`), `updateMany`, `upsert`, `delete`, `deleteMany`, `$transaction`, and `$cypher` for raw queries. `select` / `include` with nested relation `where` / `orderBy` / `skip` / `take`, typed edge properties under `$edge`, and relation filters (`some` / `none` / `every`, `is` / `isNot`). Requires Neo4j 5.6+.
  - Correct value mapping: `Int` is sent as a Neo4j integer (not a float), integers read back as `number` (throwing outside the safe range), `DateTime` / `Date` as JS `Date`.
  - Schema: scalar lists (`String[]`), `Date` type, literal defaults (`@default("x")`, `@default(0)`, `@default(true)`), and `resolveSchema()` producing a JSON `SchemaModel` with cross-reference checks (also run by `cyphra validate`).
  - CLI: fix a duplicated shebang in the built binary.

### Patch Changes

- Updated dependencies [d836db9]
  - @cyphra/schema@0.2.0
  - @cyphra/query@0.2.0
