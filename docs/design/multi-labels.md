# Design note: interfaces and multiple labels (#100)

Status: implemented in #166; follow-ups in #167 (see [Follow-ups](#follow-ups-167)).

## Problem

Today a Cyphra `node` model is exactly one Neo4j label: `node Employee { … }` reads and writes
`(:Employee)`. Graphs often share labels between kinds of nodes (`(:Employee:Person)`,
`(:Customer:Person)`) so that one query covers every person, one constraint keeps every email
unique, and one relationship (`MANAGES`) can point at any person. Cyphra needs a way to declare that,
to query "every `Person`" with typed results, and to migrate existing data to the new layout.

## Options considered

1. **Extra labels on a model** (`@@labels(["Person"])`). Cheap, but the shared label has no fields,
   no constraints and no client of its own: `db.person` cannot exist, so it solves only half the
   problem.
2. **Concrete inheritance** (`node Employee extends Person`, where `Person` is also a node you can
   create). A bare `(:Person)` and an `(:Employee:Person)` are then both "a Person": every
   `db.person` result needs an "is it only a Person?" case, `create` on `Person` and on `Employee`
   can collide on the same key, and deleting through `Person` must still know Employee's rules.
3. **Abstract interfaces** (`interface Person { … }` + `node Employee implements Person { … }`). An
   interface is a label with fields, constraints and relations; it can be queried but never
   created, so every node with its label is one of its implementations.

**Decision: option 3.** It is the GraphQL / TypeScript mental model, it maps one to one onto Neo4j
(one label per interface, constraints per label), and it keeps results typed as a discriminated
union. Option 1 is covered by it: an interface without fields (`interface Archived {}`) is just
an extra label that every implementation carries.

## Schema

```cyphra
interface Person {
  id      String  @id @default(uuid())
  email   String  @unique
  name    String
  manager Person? @relationship(type: "MANAGES", direction: IN)

  @@fulltext([name])
}

node Employee implements Person {
  salary Int
}

node Customer implements Person {
  tier String @default("free")
}
```

- `interface` takes the same body as `node`: scalar fields, relation fields, `@@unique`,
  `@@index` and `@@fulltext`. Its label is its name.
- `node X implements A, B` inherits every field of `A` then `B` (in that order, before its own
  fields) and carries the labels `X`, `A` and `B`.
- Errors: implementing something that is not an interface (or the same interface twice);
  redeclaring an inherited field; two interfaces of one node declaring the same field name; an
  inherited `@id` plus an own `@id`; `interface … implements …` (an interface `extends` others,
  see [Follow-ups](#follow-ups-167)).
- Relations may target an interface (`manager Person?`, `members Person[]`), and
  `relationship { from Person to Team }` models may name one.

### Resolved model

Interfaces are `ResolvedNodeModel`s in `SchemaModel.nodes`, so every consumer that walks nodes
(constraints, indexes, the runtime's `ctx.node()`, introspection hints) sees the interface label
without special cases. New optional properties (absent for plain schemas, so existing generated
clients and migration snapshots are unchanged; `SCHEMA_MODEL_VERSION` stays 1):

| Property          | On                              | Meaning                                                   |
| ----------------- | ------------------------------- | --------------------------------------------------------- |
| `abstract: true`  | interface                       | Can be queried, never created.                            |
| `implementations` | interface                       | Names of the nodes implementing it, in declaration order. |
| `interfaces`      | implementing node               | Interfaces it implements, in `implements` order.          |
| `labels`          | implementing node               | All its labels: own label, then each interface label.     |
| `inheritedFrom`   | field, `@@unique`, `@@fulltext` | Interface the item was copied from.                       |

## Client

### Labels in queries

- A concrete model matches and writes **all** its labels: `MATCH (n:Employee:Person)`,
  `CREATE (n:Employee:Person {…})`, `MERGE (n:Employee:Person {id: …})`. A node missing the
  interface label (data written before the interface existed) is not an `Employee` until the
  migration backfills the label.
- An interface matches its own label: `MATCH (n:Person)`.

### Reading through an interface

`db.person` has every read operation (`findMany`, `findFirst`, `findUnique`, `count`, `aggregate`,
`groupBy`, `traverse`, `shortestPath`, `search`, `findSimilar`). Results are a discriminated union:

```ts
const people = await db.person.findMany({ where: { name: { startsWith: "A" } } });
for (const p of people) {
  if (p.__typename === "Employee")
    p.salary; // number
  else p.tier; // "Customer": string
}
```

- `__typename` is decided from the node's labels (`labels(n)` is projected next to the
  properties). It is only added to results of interface queries (and of relations whose target is
  an interface), so results of concrete models keep their shape.
- Without `select`, a result has every scalar field of its implementation (the projection reads the
  union of the implementations' fields and the decoder keeps the ones of the matched
  implementation). `include` loads the interface's relations.
- With `select`, only interface fields and relations can be picked; `__typename` is always there.
- `where`, `orderBy`, `_count` take the interface's fields and relations.
- A node carrying the interface label but no implementation label (written outside Cyphra) comes
  back with `__typename` set to the interface name and the interface's fields only. Cyphra never
  writes such nodes; the TypeScript union does not model them.

### Writes

- `create`, `createMany` and `upsert` do not exist on an interface delegate (removed from its type,
  and rejected at runtime), and a nested `create` into a relation whose target is an interface is
  rejected: create through an implementation. `connect` to an interface target works by its unique
  fields (`manager: { connect: { email } }`).
- `update`, `updateMany`, `delete`, `deleteMany` work through the interface, on its fields.
- `onDelete` rules: deleting through an interface (or cascading into an interface-typed relation)
  applies the rules of each node's implementation, resolved from its labels, so an Employee
  deleted via `db.person.delete` still cascades along its own `Cascade` relations.

### Constraints and indexes

Declared once, on the label that declares them:

- `@id` / `@unique` / `@index` / `@@unique` / `@@index` / `@vectorIndex` / `@@fulltext` on an
  interface create one constraint or index for the interface label (`Person_email_unique`), which
  covers every implementation: an email is unique across Employees and Customers. Implementations
  do not get copies.
- Inherited `@@unique` keys stay valid `findUnique` / `connect` keys on implementations.
- On an implementation, an inherited `@vectorIndex` field or `@@fulltext` index still works:
  `db.employee.findSimilar` / `db.employee.search` query the interface's index and keep the nodes
  with the `Employee` label.

## Migrations

`cyphra migrate dev` diffs the resolved models, so:

- A node that starts implementing an interface gets a data step that backfills the label, ordered
  before the interface's new constraints are created:
  `MATCH (n:Employee) WHERE NOT n:Person SET n:Person`.
- A node that stops implementing an interface gets `MATCH (n:Employee) REMOVE n:Person`.
- Inherited fields are fields of the implementation, so the usual backfills (defaults) and guards
  (newly required fields) run on its label.
- Constraint names follow the declaring label, so moving `email @unique` from `Employee` into
  `interface Person` drops `Employee_email_unique` and creates `Person_email_unique`.

## Introspection (`cyphra pull`)

Neo4j reports label combinations per node. When a label `P` never appears alone and always
appears with exactly one other label of the schema (each of those labels `X` always carrying `P`),
`pull` emits `interface P { <properties every P node has> }` and `node X implements P` with the
remaining properties. Other multi-label layouts keep today's behaviour (one model per label) and are
listed in the hints.

## GraphQL importer

`@neo4j/graphql` v7 interfaces are not labels: `type Movie implements Production` stores
`(:Movie)` only, and queries on `Production` union the implementations' labels. Importing them as
Cyphra interfaces would change the stored layout (every Movie would need a `:Production` label), so
the mapping is not exact: interfaces and unions stay reported as unsupported, with a hint to declare
a Cyphra `interface` and backfill the label if that layout is wanted. `@node(labels: [...])` with
extra labels stays reported too.

## Language server

Keywords `interface` / `implements`, completion of interface names after `implements`, hover and
document symbols for interfaces, go-to-definition on implemented interfaces, and diagnostics from
schema resolution (the same errors as `cyphra validate`).

## Follow-ups (#167)

### Interfaces extending interfaces (implemented)

`interface Staff extends Person, Contact { … }`. `extends` is the interface keyword
(`implements` stays the node keyword; mixing them up is an error with a hint).

- Fields: an interface's resolved fields are its parents' (in `extends` order, each one's
  inherited fields first) then its own. `inheritedFrom` is always the **declaring** interface
  (`Employee.email` comes from `Person` even through `Staff`), so DDL stays on the declaring label
  and nothing else changes for constraints, indexes, `search` or `findSimilar`.
- Diamonds (`Staff` and `Contact` both extending `Person`, `Engineer` implementing both) are
  allowed: an item reached twice from the same declaring interface is inherited once. Two
  different interfaces declaring the same field name is still an error, and so is a cycle.
- Resolved model: an interface gets `extends` (direct) and `interfaces` (every ancestor,
  depth first); a node's `interfaces` is transitive too, and its `labels` is its own label then
  those. An interface's `implementations` is every concrete node below it (directly or not), so
  `__typename` unions, `onDelete` resolution and decoding need no change. An interface is still
  matched by its own label only (no `labels` on it): every node below it carries it.
- Migrations: label steps only run for concrete nodes, whose transitive `interfaces` already list
  every label they gain or lose. An interface's inherited fields are migrated on the declaring
  label, never on the intermediate one.
- `cyphra pull`: a group of labels seen together becomes a hierarchy when each multi-label
  combination has exactly one label of its own and its other labels form a strict chain (each
  label's nodes all carrying the next, in strictly more combinations). Several unrelated
  interfaces per node, and a shared label with a single implementation, stay one model per label
  (#185).

### `__typename` filters and sorting (implemented)

`where: { __typename: "Employee" | { equals, not, in, notIn } }` on an interface compiles to label
predicates (`n:Employee`, `(n:A) OR (n:B)`, `false` for an empty `in`), anywhere a `where` on the
interface is compiled (top level, relation filters, `_count` filters, …). Values are the
interface's implementations (typed as such); `__typename` on a node is an error.
`orderBy: { __typename }` sorts by `CASE WHEN n:A THEN 'A' … ELSE '<Interface>' END`. The result
type is not narrowed by the filter (the `where` is not a type parameter of the delegate methods);
narrow on `__typename`.

### Per-implementation loads: `$on` (implemented)

`include: { $on: { Employee: { team: true } } }` and
`select: { name: true, $on: { Employee: { salary: true, team: true } } }`. Each part is that
implementation's own `select` (for `include`, restricted to relations and `_count`), compiled as a
projection of the same node and evaluated only on its nodes:
`` `__on_Employee`: CASE WHEN n:`Employee` THEN n{…} END ``. The decoder merges the part of the
node's implementation into the result (`_count` merged with the interface's). In the types, member
`T` of the result union gets `SelectPayload<T, $on[T]>` / `IncludedRelations<T, $on[T]>`; other
members are unchanged. Computed fields (`$extends({ result })`) apply inside `$on`. `GraphQL`
called this `... on Employee`; `$on` keeps the `$` prefix of Cyphra's other non-field keys
(`$edge`, `$score`).

### Narrowing inherited fields (not planned)

Redeclaring `bio String` on `Employee` when `Person.bio` is `String?` (or restricting an enum)
cannot be guaranteed: `db.person.updateMany({ data: { bio: null } })` writes through the interface,
where only the interface's version of the field is known, so every write through an interface
would need a per-implementation check of the matched nodes. Declaring the field on each
implementation gives the same model without the hole.

### Unions of unrelated models (#183)

`union SearchHit = Post | User`: a type, not a label (nothing written or migrated). Relations may
target it (the target pattern becomes `(m) WHERE m:Post OR m:User`), and results are decoded like
interface results (`labels(n)` → `__typename`). There are no shared fields, so `where`, `select` and
`include` take `__typename` and `$on` only, there is no unique key (no `findUnique`, and `connect`
names the member: `connect: { Post: { id } }`), and no constraint. Open: whether a union has a
delegate at all or only appears as a relation target. `@neo4j/graphql` v7 unions are exactly this,
so `@cyphra/graphql` could map them once it exists.

### Dynamic labels (#184)

Labels that come and go on individual nodes (`:Archived`, `:Featured`). They would be declared on
the model (`@@labels([Archived, Featured])`) so they are typed, never collide with model or
interface labels, and come from the schema only (never from values: no injection). Writes take
`data: { $labels: { add, remove } }` (`SET n:Archived` / `REMOVE n:Featured`), filters
`where: { $labels: { has, hasSome, hasEvery } }`, and removing a flag from the schema offers a
destructive `REMOVE` step. Label predicates and `SET n:L` work on Memgraph too.

### GraphQL interfaces (not planned)

`@neo4j/graphql` v7 interfaces add no label (see [GraphQL importer](#graphql-importer)), so there is
no exact mapping; `@cyphra/graphql` and the importer keep reporting them as unsupported.
