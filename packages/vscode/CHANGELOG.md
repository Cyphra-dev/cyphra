# Changelog

## 0.2.0

- `@out(TYPE)` / `@in(TYPE)` relation fields and short-form `relationship TYPE { … }` blocks:
  highlighting (the type as a type name), completion of the relationship types inside `@out(` /
  `@in(`, hover with the edges, properties and inverse field, go to definition, references and
  rename of a type, and the quick fix "Add inverse field on <Target>".
- Warnings for nearly identical relationship types.
- The `relationship` and `rel` snippets use the new forms (`relationship from to` for the long
  form).

## 0.1.0

- First release: highlighting, diagnostics, completion, hover, go to definition, references,
  rename, outline, formatting (comments kept), snippets, **Cyphra: Generate client** and a status
  bar item for `.cyphra` schema files.
