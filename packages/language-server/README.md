# @cyphra/language-server

> Part of [Cyphra](https://www.cyphra.dev), the TypeScript OGM (object-graph mapper) for Neo4j. **Editor docs:** [www.cyphra.dev/editor](https://www.cyphra.dev/editor)

Language server (LSP) for Cyphra `.cyphra` schema files, used by the Cyphra VS Code extension and
by any LSP client (Neovim, Helix, …):

- diagnostics that match `cyphra validate`, on the exact field, type, decorator or argument, and
  its warnings (nearly identical relationship types);
- completion of keywords, built-in types, models and enums, decorators and their arguments
  (relationship types inside `@out(` / `@in(`), `@default(…)` values and `@@fulltext([…])` fields;
- hover documentation, relation target summaries, and the edges, properties and inverse field of a
  relationship type;
- go to definition, find references and rename for models, enums and relationship types;
- the quick fix "Add inverse field on <Target>" (`codeActionsAt`);
- document symbols (outline) and formatting that keeps comments.

## Usage

```bash
npm i -g @cyphra/language-server
cyphra-language-server --stdio
```

Neovim 0.11+:

```lua
vim.filetype.add({ extension = { cyphra = "cyphra" } })
vim.lsp.config("cyphra", {
  cmd = { "cyphra-language-server", "--stdio" },
  filetypes = { "cyphra" },
  root_markers = { "cyphra.json", ".git" },
})
vim.lsp.enable("cyphra")
```

The features are also exported as plain functions (`analyze`, `completionsAt`, `hoverAt`,
`definitionAt`, `referencesAt`, `renameEdits`, `codeActionsAt`, `outline`, `formatText`) and `startServer(connection)`
starts the server on an existing `vscode-languageserver` connection.

## License

MIT
