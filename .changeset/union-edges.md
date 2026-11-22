---
"@cyphra/schema": minor
"@cyphra/runtime": minor
"@cyphra/migrator": minor
"@cyphra/language-server": minor
"cyphra": minor
---

Typed edges on relations to a union: a `relationship { … }` model may name a union in `from` / `to` (one edge model for every member, also used by the members' inverse fields). `$edge` goes next to the member key in `connect`, `create` and `set` items (`connect: { Post: { id }, $edge: { rank: 2 } }`), every loaded member comes back with its typed `$edge`, and traversals filter on it with `edgeWhere`. The migrator emits the same relationship property constraints, indexes and backfills as for a node end (they are per relationship type).

Interfaces as union members: `union Party = Person | Team` with `interface Person` stands for every implementation of `Person`. It is matched by the interface's label, results are the implementations (typed by `__typename`), and writes and `$on` may name the interface (`connect: { Person: { email } }`, `where: { $on: { Person: { … } } }`, `select: { $on: { Person: { … } } }`); a nested `create` names an implementation. A node listed twice (directly and through an interface) is a validation error. The type map gets `members` for unions with an interface member, and the language server completes interface names in a union.
