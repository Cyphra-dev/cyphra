# Cyphra for Visual Studio Code

> Part of [Cyphra](https://www.cyphra.dev), the TypeScript OGM (object-graph mapper) for Neo4j. **Docs:** [www.cyphra.dev/editor](https://www.cyphra.dev/editor)

Language support for Cyphra schema files (`schema.cyphra`):

- **Highlighting** of nodes, relationships, enums, types, decorators and `@@` model attributes.
- **Diagnostics while you type**, the same errors as `cyphra validate`, underlined where they are,
  and its warnings (nearly identical relationship types).
- **Completion**: keywords, built-in types, your models and enums, decorators and their
  arguments (relationship types inside `@out(` / `@in(`, vector similarity, full-text analyzers), `@default(…)` values
  for the field's type, String fields inside `@@fulltext([…])`, scalar fields inside
  `@@unique([…])` / `@@index([…])`.
- **Hover** documentation for types and decorators, a summary of relation targets and enums, and
  the edges, properties and inverse field of a relationship type (`@out(AUTHORED)`).
- **Go to definition**, **find references** and **rename** for models, enums and relationship
  types.
- **Quick fix** "Add inverse field on <Target>" on a relation field without one.
- **Outline** (document symbols) and **formatting** that keeps your comments (`Format Document`,
  the same output as `cyphra format`).
- **Cyphra: Generate client** runs `cyphra generate` in a terminal, from the folder holding
  `cyphra.json` (through the package manager of your lockfile; override with
  `cyphra.generateCommand`).
- A **status bar item** shows whether the open schema is valid.
- Snippets: `node`, `relationship`, `enum`, `rel` (relation field), `id`, `vector`, `@@fulltext`, `@@unique`,
  `@@index`.

The language server is also published on npm as
[`@cyphra/language-server`](https://www.npmjs.com/package/@cyphra/language-server) for Neovim,
Zed, Helix and other LSP editors: see [www.cyphra.dev/editor](https://www.cyphra.dev/editor).

## Settings

| Setting                  | Description                                                                |
| ------------------------ | -------------------------------------------------------------------------- |
| `cyphra.generateCommand` | Command run by **Cyphra: Generate client** (default: detected per project) |
| `cyphra.trace.server`    | Trace the language server protocol (`off`, `messages`, `verbose`)          |

## License

MIT
