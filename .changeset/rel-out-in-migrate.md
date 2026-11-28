---
"@cyphra/migrator": minor
"@cyphra/cli": minor
---

Renaming a relationship type makes `cyphra migrate dev` generate the data migration: when a relation field keeps its name, target and direction but its type changes (`@out(AUTHORED)` → `@out(WROTE)`, either syntax, one side or both), the migration recreates the existing edges between those models with the new type and their properties (`MATCH (a:User)-[r:AUTHORED]->(b:Post) CREATE (a)-[n:WROTE]->(b) SET n = properties(r) DELETE r`), with a review warning. Types that disappear and appear with renamed fields get a warning, like renamed fields. New helper for hand-written migrations: `db.migrate.renameRelationshipType({ from, to, startLabel?, endLabel? })` (and `compileRenameRelationshipType`).
