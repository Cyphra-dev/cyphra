---
"@cyphra/schema": minor
"@cyphra/runtime": minor
"@cyphra/migrator": minor
"@cyphra/language-server": minor
---

Interfaces follow-ups (#167):

- **Interfaces extending interfaces**: `interface Staff extends Person, Contact { … }`. Fields are inherited transitively (once through a diamond), implementations carry every label up the chain (`:Engineer:Staff:Person:Contact`), each interface's delegate returns the implementations below it, and constraints and indexes stay on the declaring label. The resolved model gives interfaces `extends` and transitive `interfaces`, and nodes transitive `interfaces` / `labels`. Migrations backfill (or remove) every gained (or lost) label, `cyphra pull` recognizes chains of labels as `interface … extends …`, and the language server knows `extends` (completion, hover, go-to-definition, diagnostics).
- **`where: { __typename }`** on interface queries (an implementation name or `{ equals, not, in, notIn }`, typed with the implementation names, compiled to label predicates) and **`orderBy: { __typename }`**.
- **`$on`** in `select` / `include` of an interface query loads an implementation's own fields and relations on its results only: `include: { $on: { Employee: { team: true } } }`; result types narrow per `__typename`, and computed fields apply inside it.
