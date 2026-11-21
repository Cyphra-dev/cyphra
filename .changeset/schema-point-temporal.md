---
"@cyphra/schema": minor
"@cyphra/runtime": minor
"@cyphra/migrator": minor
"cyphra": minor
"@cyphra/language-server": minor
---

Schema: spatial `Point` / `CartesianPoint` and the temporal `LocalDateTime`, `LocalTime`, `Time` and
`Duration` types, end to end.

- **`Point`** (WGS-84, `{ longitude, latitude, height? }`) and **`CartesianPoint`** (`{ x, y, z? }`)
  are stored as Neo4j points (2D or 3D) and exported as JS types. They filter on equality,
  `distance: { from, lt, lte, gt, gte }` (`point.distance`, meters for WGS-84) and
  `withinBBox: { lowerLeft, upperRight }` (`point.withinBBox`), and sort by distance:
  `orderBy: { location: { distanceFrom: here } }`. `@index` on a point field creates a
  `POINT` index (migrations, `cyphra push`, `cyphra schema ddl`).
- **`LocalDateTime`**, **`LocalTime`**, **`Time`** and **`Duration`** are ISO 8601 strings in JS
  (`"2024-05-01T10:30:00"`, `"10:30:00"`, `"10:30:00+02:00"`, `"PT1H30M"`), typed with exported
  template literal types and returned in the `Temporal` API's format, from either `neo4j-driver`
  major. Neo4j stores, compares and sorts them as temporal values. The first three filter with
  `lt` / `gt`, sort and take `_min` / `_max`; durations have no total order, so they compare for
  equality only. `@default(now())` works on `LocalDateTime`, `LocalTime` and `Time` (UTC wall
  clock), and all four take an ISO text default (`@default("PT45M")`).
- `cyphra pull` keeps these types (a point property becomes `Point` or `CartesianPoint` from the
  CRS of its sampled values; a `LocalDateTime` property is no longer pulled as `DateTime`) and maps
  point indexes to `@index`. Migrations backfill temporal defaults with Cypher temporal values.
- A node named like one of these types (`node Point { … }`) still works as a relation target.
- The language server and VS Code extension highlight, complete and document the new types.
