---
"@cyphra/runtime": minor
"@cyphra/migrator": minor
"@cyphra/better-auth": minor
"@cyphra/cli": minor
"cyphra": minor
---

Support `neo4j-driver` 6 alongside 5.28 (`^5.28.3 || ^6.0.0`).

- `@cyphra/runtime`, `@cyphra/migrator` and `@cyphra/better-auth` now declare `neo4j-driver` as a peer dependency, so your app and Cyphra share a single driver. `cyphra` and `@cyphra/cli` depend on it directly with the same range, so `npm i cyphra` still works on its own. If you install the `@cyphra/*` subpackages with a package manager that does not install peer dependencies (Yarn), add `neo4j-driver` yourself.
- `new CyphraClient({ driver })` and `createClient({ driver })` reuse a `Driver` your app already created (5.28+ or 6.x, even from another copy of the package). Cyphra does not close a driver you pass in.
