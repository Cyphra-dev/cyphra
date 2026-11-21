---
"@cyphra/language-server": minor
---

New package `@cyphra/language-server`: a language server for `.cyphra` schema files, used by the Cyphra VS Code extension and usable from Neovim, Zed, Helix or any LSP client (`cyphra-language-server --stdio`). Diagnostics match `cyphra validate` and underline the field, type, decorator or argument at fault; completion of keywords, built-in types, models and enums, decorators and their arguments, `@default(…)` values and `@@fulltext([…])` fields; hover docs and relation target summaries; go to definition, find references and rename for models and enums; document outline; formatting that keeps comments.
