---
"@cyphra/language-server": minor
---

Relationship types in the editor: completion of the schema's types inside `@out(` / `@in(` (and `onDelete` after it), hover on a type with its edges (`(User)-[:AUTHORED]->(Post)`), its edge properties and the inverse field, go to definition (the `relationship` block), find references and rename of a type (every `@out` / `@in` / `@relationship` field and its block), the code action "Add inverse field on <Target>" (`codeActionsAt`), and warnings for nearly identical relationship types. `@out` and `@in` are documented and offered first on relation fields; the `relationship` snippet writes the short form.
