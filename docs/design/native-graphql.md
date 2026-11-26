# Design note: the Cyphra-native GraphQL API (#77)

Status: design agreed; the open questions were decided by the maintainer (see
[Decisions](#decisions)). Nothing here is implemented. Part of the GraphQL epic (#68); the phased
plan at the end lists candidate sub-issues.

## Problem

`compat.v7.makeSchema` serves the API `@neo4j/graphql` 7.6.8 generates, byte for byte (the printed
SDL of the 8 fixture apps is identical, 119 of 121 checks of `compat/graphql` pass; the two others
are deliberate, see [Divergences we already have](#divergences-we-already-have)). That is the right
API for teams switching from v7 without touching their frontends, and it keeps every rough edge of
v7:

- generated plural names (`movies`, `createMovies`, `@plural` to fix the odd ones);
- two list APIs for one thing (`movies` and `moviesConnection`), and edge properties only through
  the connection one (`actorsConnection { edges { properties { role } } }`);
- very large input types (`MovieWhere` with every deprecated `title_CONTAINS` form, one
  `…FieldInput` / `…ConnectFieldInput` / `…UpdateConnectionInput` family per relationship);
- `connect` is a `CREATE`: connecting an already connected pair adds a second relationship;
- delete mutations return `info { nodesDeleted }` counters, not the deleted records;
- authorization rules are strings inside SDL directives (`where: { node: { author: { single: { id:
{ eq: "$jwt.sub" } } } } }`), checked only when the schema is built, and with v7 semantics that
  matter for security: `where` / `sort` / aggregation filters can probe fields and nodes the user
  cannot read, `AGGREGATE` rules are separate from `READ` rules, relationship-only updates skip the
  node's `UPDATE` rules, `create` responses ignore `READ` rules;
- `Date` inputs read in the process time zone, an invalid cursor silently returns the first page,
  `{ eq: null }` and `some: {}` have surprising meanings.

Meanwhile the typed client (`db.user.findMany`, `select` / `include`, `$edge`, `$on`, `aggregate`,
`groupBy`, `traverse`, `search`, union search, `$extends`) already has the semantics we want, typed
from `schema.cyphra`, with every operation compiled to one Cypher statement. The native API should
be that client, over GraphQL.

## Goals

1. **Generated from `schema.cyphra`**, not from SDL with directives. The data model has one source
   of truth; what the API exposes (operations, hidden fields, rules, custom fields) is configured in
   TypeScript, typed against the generated client, so a rule on an unknown field fails `tsc` (the
   acceptance criterion of #77).
2. **Same semantics as the typed client.** A GraphQL operation is translated into exactly one
   client operation (`findMany`, `create`, …) with the same arguments, so filters, ordering,
   defaults, validation rules, `onDelete` rules, `connect` semantics, errors and `$extends` hooks
   behave identically from TypeScript and from GraphQL. Where GraphQL cannot express a client
   shape, the GraphQL shape is a mechanical, documented rewrite of it (see
   [Naming conventions](#naming-conventions)).
3. **Fix the v7 footguns** listed above, on purpose and with a test each.
4. **One statement per root field**, no N+1, like `compat.v7` and the client today.
5. **Side by side with `compat.v7`** in the same server, on the same graph, with a mapping table, a
   codemod for operation documents and a dual-run check to move frontends over at their own pace.
6. **A stable, printable contract**: the generated SDL is deterministic, can be committed and
   checked in CI, and changes only with an explicit version bump.

Non-goals: reproducing v7 (that is `compat.v7`), a schema-first API where the user writes SDL and
Cyphra fills in resolvers (custom SDL is an extension point, not the source of the model), and
Relay `Node` / global ids by default (opt-in with `relay: true`, see [Decisions](#decisions)).

## Entry point

```ts
import { native } from "@cyphra/graphql";
import { createClient } from "./cyphra.gen.js";
import { api } from "./graphql.config.js";

const db = createClient({ uri, user, password });

export const schema = native.makeSchema({
  client: db, // or (ctx) => db.$extends(forRequest(ctx)), see Auth
  config: api, // from defineGraphQL, below
});
```

`native.makeSchema` reads the resolved `SchemaModel` from the client (no type definitions to pass)
and returns a `GraphQLSchema` with resolvers, like `compat.v7.makeSchema`, so it is served by
GraphQL Yoga, Apollo Server or anything else.

## Architecture: one engine

Decided by the maintainer: there is **one GraphQL engine**. The native API, built on the typed
client's compiler, is the core, and `compat.v7` becomes a thin translation layer on top of it (v7
request → native / client call → v7-shaped response). A fix to filtering, paging, rules or
statement building lands once and serves both APIs.

- Both stay in `@cyphra/graphql` (`import { compat, native } from "@cyphra/graphql"`); no separate
  package.
- The `compat/graphql` golden suite keeps guarding v7 behaviour during and after the refactor. v7
  semantics the native API changes on purpose (duplicate-edge `connect`, v7 auth semantics, offset
  cursors, …) are reproduced by the translation layer or by engine options it passes; a golden diff
  blocks the change otherwise.
- Order: native reads and writes first, then `compat.v7` moves onto the shared engine (phase 4 of
  the [plan](#implementation-plan-candidate-sub-issues)). The seven compat gaps filed as #223–#229
  are fixed in the current compat compiler first; they do not wait for the refactor.

```ts filename="graphql.config.ts"
import { defineGraphQL } from "@cyphra/graphql/native";
import type { CyphraTypeMap } from "./cyphra.gen.js";

type Ctx = { user?: { id: string; role: "MEMBER" | "ADMIN" } };

export const api = defineGraphQL<CyphraTypeMap, Ctx>({
  models: {
    User: {
      operations: { read: true, create: false, update: ["update"], delete: false },
      fields: { passwordHash: false, email: { read: ({ ctx }) => ctx.user?.role === "ADMIN" } },
    },
    Post: {
      rules: {
        read: ({ ctx }) => ({
          OR: [{ published: true }, { author: { is: { id: ctx.user?.id ?? "" } } }],
        }),
        update: ({ ctx }) => ({ author: { is: { id: ctx.user?.id ?? "" } } }),
        delete: ({ ctx }) =>
          ctx.user?.role === "ADMIN" ? true : { author: { is: { id: ctx.user?.id ?? "" } } },
      },
    },
  },
});
```

Every key of `models`, `fields` and every `where` a rule returns is typed from `CyphraTypeMap`
(the client's own `WhereInput<TM, "Post">`), so `{ publishd: true }` or `fields: { pasword: false }`
is a compile error. `makeSchema` also checks the config at startup (for JavaScript users and for
rules built dynamically): an unknown model, field or operation throws, as `checkRules` does for v7
today.

## Running example

```cyphra filename="schema.cyphra"
enum Role {
  MEMBER
  ADMIN
}

node User {
  id           String  @id @default(cuid())
  email        String  @unique
  name         String?
  role         Role    @default(MEMBER)
  loginCount   Int     @default(0)
  passwordHash String
  posts        Post[]  @relationship(type: "AUTHORED", direction: OUT, onDelete: Cascade)
  following    User[]  @relationship(type: "FOLLOWS", direction: OUT)
  followers    User[]  @relationship(type: "FOLLOWS", direction: IN)
}

node Post {
  id        String   @id @default(cuid())
  title     String   @length(3, 100)
  body      String
  published Boolean  @default(false)
  views     Int      @default(0)
  createdAt DateTime @default(now())
  author    User?    @relationship(type: "AUTHORED", direction: IN)
  tags      Tag[]    @relationship(type: "TAGGED", direction: OUT)

  @@fulltext([title, body], name: "postSearch", analyzer: "english")
}

node Tag {
  name  String @id
  posts Post[] @relationship(type: "TAGGED", direction: IN)
}

relationship Follows {
  type  "FOLLOWS"
  from  User
  to    User
  since DateTime @default(now())
}
```

## Naming conventions

GraphQL names cannot contain `$` and cannot start with `__`, and GraphQL has no input unions of a
scalar and an object. The rewrite from client shapes is mechanical:

| Client                                    | GraphQL                                             |
| ----------------------------------------- | --------------------------------------------------- |
| `db.post.findMany(args)`                  | `postFindMany(...args)` (root field)                |
| `$edge`                                   | `_edge`                                             |
| `$score`, `$scores`                       | `_score`, `_scores`                                 |
| `$labels`                                 | `_labels`                                           |
| `$on` (in `where`)                        | `_on`                                               |
| `$on` (in `select` / `include`)           | inline fragments: `... on Employee { salary }`      |
| `__typename` (in `where` / `orderBy`)     | `_typename` (selection keeps the built-in)          |
| `_count`                                  | `_count` (unchanged)                                |
| `select` / `include`                      | the selection set                                   |
| `where: { email: "a@x.io" }` (bare value) | `where: { email: { equals: "a@x.io" } }`            |
| `orderBy: { createdAt: "desc" }`          | `orderBy: [{ createdAt: desc }]` (`SortOrder` enum) |
| `data: { views: { increment: 1 } }`       | `data: { _ops: { views: { increment: 1 } } }`       |

- **Root fields** are `<delegateKey><Operation>`: no pluralization, nothing to guess, and the
  fields of one model sort together in explorers. `node BlogPost` gives `blogPostFindMany`.
  `config.naming` can override single names (`{ Person: { findMany: "people" } }`); the override is
  part of the printed contract.
- **Types** keep the model names (`User`, `Post`, `Follows`); generated inputs are
  `<Model><Role>` (`PostWhere`, `PostWhereUnique`, `PostOrderBy`, `PostCreateInput`,
  `PostUpdateInput`). Shared inputs are generated once per scalar type (`StringFilter`,
  `IntFilter`, `DateTimeFilter`, …), not once per field.
- A model field starting with `_` that collides with one of the reserved names above
  (`_edge`, `_score`, `_scores`, `_labels`, `_count`, `_ops`, `_on`, `_typename`) is a
  `makeSchema` error naming the field and the `naming.reserved` override.

## Generated schema

The SDL below is what the running example would print (abridged with `…`; the full contract is
printed sorted, see [Versioning](#versioning-and-the-printed-contract)).

### Object types

```graphql
type User {
  id: ID!
  email: String
  name: String
  role: Role!
  loginCount: Int!
  posts(where: PostWhere, orderBy: [PostOrderBy!], skip: Int, take: Int): [Post!]!
  following(where: UserWhere, orderBy: [UserOrderBy!], skip: Int, take: Int): [User!]!
  followers(where: UserWhere, orderBy: [UserOrderBy!], skip: Int, take: Int): [User!]!
  _count: UserCount!
  "Edge properties when this User was reached through a relation with a relationship model."
  _edge: Follows
}

type Post {
  id: ID!
  title: String!
  body: String!
  published: Boolean!
  views: Int!
  createdAt: DateTime!
  author: User
  tags(where: TagWhere, orderBy: [TagOrderBy!], skip: Int, take: Int): [Tag!]!
  _count: PostCount!
  "Relevance score when this Post comes from postSearch."
  _score: Float
}

type Follows {
  since: DateTime!
}

type UserCount {
  posts(where: PostWhere): Int!
  following(where: UserWhere): Int!
  followers(where: UserWhere): Int!
}
```

- `@id` fields are `ID!`; other scalars keep their Cyphra types (`DateTime`, `Date`,
  `LocalDateTime`, `LocalTime`, `Time`, `Duration` as ISO 8601 strings, `BigInt` as a decimal
  string, `Json` as a JSON scalar, `Point` / `CartesianPoint` as object types with matching inputs,
  `Vector(N)` as `[Float!]`). Enums become GraphQL enums. Optional fields are nullable.
- `email` is nullable in GraphQL although it is required in `schema.cyphra`: it has a field-level
  read rule, and a field the request may not read is returned as `null` with a `FORBIDDEN` error
  at its path (see [Field rules](#field-rules)). Fields without such a rule keep their nullability.
  `passwordHash: false` removes the field from every type and input.
- **To-one relations are nullable objects** (`author: User`), whether the Cyphra field is `User?`
  or `User`: a required to-one relation is a schema intent that Neo4j does not enforce, and the
  client types it `| null` too. To-many relations are `[T!]!` with `where`, `orderBy`, `skip`,
  `take`, as in a nested `include` of the client.
- **Context fields** (`_edge`, `_score`, `_scores`) are nullable and only meaningful where the
  client would return `$edge` / `$score`: `_edge` on a node reached through a relation with a
  relationship model, `_score` on results of `search` / `findSimilar`. Selecting one outside its
  context is a validation error (`_edge is only available on User reached through a relation with
an edge model`), not a silent `null`, because the whole selection is compiled before anything
  runs. When several relationship models target one node model, `_edge` is a union of them
  (`union UserEdge = Follows | Blocks`), selected with inline fragments.

### Queries

```graphql
type Query {
  userFindUnique(where: UserWhereUnique!): User
  userFindFirst(where: UserWhere, orderBy: [UserOrderBy!], skip: Int): User
  userFindMany(
    where: UserWhere
    orderBy: [UserOrderBy!]
    skip: Int
    take: Int
    after: String
    before: String
  ): UserList!
  userCount(where: UserWhere): Int!
  userAggregate(where: UserWhere, orderBy: [UserOrderBy!], skip: Int, take: Int): UserAggregate!
  userGroupBy(
    by: UserGroupByInput!
    where: UserWhere
    having: UserHaving
    orderBy: [UserGroupOrderBy!]
    skip: Int
    take: Int
  ): [UserGroup!]!
  postSearch(
    index: PostFulltextIndex!
    query: String!
    mode: SearchMode
    where: PostWhere
    minScore: Float
    skip: Int
    take: Int
  ): [Post!]!
  …
}

type UserList {
  nodes: [User!]!
  pageInfo: PageInfo!
  "Number of nodes matching where, ignoring paging. Counted only when selected."
  totalCount: Int!
}

type PageInfo {
  hasNextPage: Boolean!
  hasPreviousPage: Boolean!
  startCursor: String
  endCursor: String
}
```

**One list query** with offset and cursor paging (issue #77). `skip` / `take` page by offset, as in
the client; `after` / `before` page by cursor. `pageInfo` and `totalCount` are only computed when
selected, in the same statement (`totalCount` is a `COUNT {}` next to the page). A query with
`after` and `skip` is allowed (skip within the page after the cursor, as in Prisma).

Cursors are **keyset cursors**, not offsets: an opaque, versioned encoding of the `orderBy` values
of the boundary node plus its `@id` (always appended as the last sort key so the order is total).
A page after a cursor is stable when nodes are inserted before it, which offset cursors (v7's
`base64("arrayconnection:<offset>")`) are not. An invalid or foreign cursor (built for another
`orderBy` or another model) is a `BAD_USER_INPUT` error, not the first page. This needs `cursor`
support in the client's `findMany` first (see [Runtime prerequisites](#runtime-prerequisites)); the
GraphQL layer only encodes and decodes it.

```graphql
query Feed($after: String) {
  postFindMany(
    where: { published: { equals: true }, author: { is: { role: { equals: ADMIN } } } }
    orderBy: [{ createdAt: desc }]
    take: 20
    after: $after
  ) {
    nodes {
      id
      title
      author {
        name
      }
      tags(take: 3, orderBy: [{ name: asc }]) {
        name
      }
      _count {
        tags
      }
    }
    pageInfo {
      hasNextPage
      endCursor
    }
    totalCount
  }
}
```

The resolver translates it into

```ts
db.post.findMany({
  where: { published: true, author: { is: { role: "ADMIN" } } },
  orderBy: [{ createdAt: "desc" }],
  take: 20,
  cursor: { after },
  select: {
    id: true,
    title: true,
    author: { select: { name: true } },
    tags: { take: 3, orderBy: [{ name: "asc" }], select: { name: true } },
    _count: { select: { tags: true } },
  },
});
```

and runs it as one statement.

**Edge properties, the `$edge` way.** No connection types: the edge is a field of the node it
leads to.

```graphql
query {
  userFindUnique(where: { email: "alice@acme.io" }) {
    following(where: { name: { startsWith: "B" } }, orderBy: [{ name: asc }]) {
      name
      _edge {
        since
      }
    }
  }
}
```

Relation filters on edges use `_edge` too, as the client's `edgeWhere` / `$edge` filters do:
`following: { some: { _edge: { since: { gte: "2024-01-01T00:00:00Z" } } } }`. Ordering a relation
by an edge property is `orderBy: [{ _edge: { since: desc } }]`. Both need the client to accept the
same shapes (they are listed in [Runtime prerequisites](#runtime-prerequisites) when they are not
there yet).

### Filters

`UserWhere` mirrors the client's `WhereInput`:

```graphql
input UserWhere {
  AND: [UserWhere!]
  OR: [UserWhere!]
  NOT: UserWhere
  id: IDFilter
  email: StringFilter
  name: StringFilter
  role: RoleFilter
  posts: PostListRelationFilter
  following: UserListRelationFilter
  followers: UserListRelationFilter
}

input StringFilter {
  equals: String
  not: String
  in: [String!]
  notIn: [String!]
  lt: String
  lte: String
  gt: String
  gte: String
  contains: String
  startsWith: String
  endsWith: String
  mode: QueryMode
}

input PostListRelationFilter {
  some: PostWhere
  none: PostWhere
  every: PostWhere
}

input UserRelationFilter {
  is: UserWhere
  isNot: UserWhere
}
```

- Operators and their semantics are the client's (table in `/client#filters`): `mode:
insensitive`, list operators `has` / `hasEvery` / `hasSome` / `isEmpty`, `Point` `distance` /
  `withinBBox`, temporal comparisons as temporal values, `$labels` as `_labels`.
- `email: null` matches nodes without the property, as the client's `null`. The only shape GraphQL
  loses is the bare value (`email: "a@x.io"`): it is `{ equals: "a@x.io" }`.
- `some: {}` means "has at least one", as in the client (v7 ignores it).
- `posts: null` on a to-one relation (`author: null`) means "no related node", as in the client.
- **Rules apply inside filters.** A relation filter only sees related nodes the request may read
  (`userFindMany(where: { posts: { some: { title: … } } })` cannot reveal a hidden post), and a field
  that is not readable cannot be filtered or sorted on (`FORBIDDEN`). This is the main security fix
  over v7, see [Auth](#auth).

### Ordering

```graphql
input PostOrderBy {
  title: SortOrder
  views: SortOrder
  createdAt: SortOrder
  author: UserOrderBy # to-one: sort by a field of the related node
  tags: RelationCountOrder # to-many: { _count: desc, where: TagWhere }
  _score: SortOrder # in search results only
}
```

`orderBy` is a list so that keys keep their order (input object field order is not significant in
every client library); one key per element, more is a `BAD_USER_INPUT` error.

### Aggregates and groupBy

```graphql
query {
  postAggregate(where: { published: { equals: true } }) {
    _count {
      _all
    }
    _avg {
      views
    }
    _max {
      createdAt
    }
  }
  postGroupBy(
    by: { fields: [published], author: [name] }
    having: { views: { _sum: { gte: 100 } } }
    orderBy: [{ _sum: { views: desc } }]
  ) {
    published
    author {
      name
    }
    _sum {
      views
    }
  }
}
```

- Only the selected aggregates are computed (the selection is the client's `_count` / `_sum` / …
  arguments). Types follow the client table: `_avg` is `Float`, `_sum` of a `BigInt` is `BigInt`,
  empty matches give `0` counts and `null` for the rest.
- `by` is an input object instead of the client's `"author.name"` strings: `fields` lists the
  model's scalars, each to-one relation lists its target's scalars. Results nest the same way.
- `aggregate` and `groupBy` apply the model's read rule, the same as `findMany` (no separate
  `AGGREGATE` rule; see [Auth](#auth)).

### Traversals and search

`Chunk` (with a `Vector(1536)` field) and `union SearchHit = Post | User | Comment` (with a
`userName` index on `User`) come from the client docs' examples, not the running example.

```graphql
query ($vector: [Float!]!) {
  userTraverse(
    from: { email: { equals: "alice@acme.io" } }
    via: [following]
    depth: { max: 2 }
    where: { name: { not: null } }
    take: 20
  ) {
    name
  }
  postSearch(index: postSearch, query: "graph databases", mode: terms, take: 10) {
    title
    _score
  }
  chunkFindSimilar(field: embedding, vector: $vector, k: 5) {
    text
    _score
  }
  searchHitSearch(
    query: "graph"
    mode: terms
    indexes: { Post: postSearch, User: userName }
    where: { _on: { Post: { published: { equals: true } } } }
    take: 20
  ) {
    __typename
    ... on Post {
      title
      _score
    }
    ... on User {
      name
      _score
    }
  }
}
```

- `<model>Traverse` and `<model>ShortestPath` cover traversals over relations back to the same
  model (`via` is an enum of those relations, `depth.max` capped by the client's
  `maxTraversalDepth` and by `config.maxTraversalDepth`, lower wins). `returnPaths` is a separate
  field, `<model>TraversePaths`, returning `{ node, path { nodes, edges { type direction _edge } } }`,
  because a GraphQL field has one return type.
- **Multi-hop traversals across models** (`Chunk → Entity → Chunk`) have a result type that depends
  on the last hop. Instead of a generic root field, they are **named traversal fields** declared in
  the config, which also bounds what clients may ask the database to explore:

  ```ts
  traversals: {
    Chunk: {
      context: {
        via: [{ rel: "entities" }, { rel: "related", direction: "both", depth: { max: 2 } }, { rel: "chunks" }],
        args: ["where", "orderBy", "take"], // what the client may pass
      },
    },
  },
  ```

  which generates `Chunk.context(where: ChunkWhere, orderBy: [ChunkOrderBy!], take: Int): [Chunk!]!`
  compiled into the parent's statement.

- `search`, `findSimilar` and union search map one to one to the client, `_score` / `_scores` on
  the results (`_scores` is a list `[IndexScore!]` of `{ index, score, normalized, rank }`, since
  GraphQL objects cannot have dynamic keys). `findSimilar` takes a vector; apps that embed on the
  server expose a [custom resolver](#custom-resolvers-and-computed-fields) taking text instead
  (the usual case), so raw vector search is off by default.
- Traversals, shortest paths and raw vector search are **off by default** (they are the expensive
  ones); `operations: { traverse: true }` turns them on per model.

### Interfaces and unions

Cyphra interfaces are labels shared by their implementations (`(:Employee:Person)`), so they map
one to one onto GraphQL interfaces, which v7 cannot do (its interfaces add no label and
`compat.v7` rejects them).

```graphql
interface Person {
  id: ID!
  email: String!
  name: String!
  manager: Person
}

type Employee implements Person {
  id: ID!
  email: String!
  name: String!
  manager: Person
  salary: Int!
  team: Team
}

type Customer implements Person {
  id: ID!
  email: String!
  name: String!
  manager: Person
  tier: String!
}

union SearchHit = Post | User | Comment
```

```graphql
query {
  personFindMany(
    where: { _on: { Employee: { salary: { gt: 100 } }, Customer: {} } }
    orderBy: [{ _typename: asc }, { name: asc }]
  ) {
    nodes {
      __typename
      name
      manager {
        name
      }
      ... on Employee {
        salary
        team {
          name
        }
      }
      ... on Customer {
        _count {
          orders
        }
      }
    }
  }
}
```

- Inline fragments are the client's `$on`: the selection under `... on Employee` becomes
  `$on: { Employee: { … } }`, evaluated only on Employee nodes, in the same statement. Fragments on
  the interface itself are ordinary selections.
- `where: { _typename: { in: [Employee] } }` and `_on` are the client's `__typename` and `$on`
  filters, typed with an enum of the implementations.
- An interface extending another becomes a GraphQL interface implementing an interface (GraphQL
  2021+).
- Interfaces have no `create` / `createMany` / `upsert` root fields; relations that target an
  interface have no nested `create` (the input type does not have it), only `connect` by the
  interface's unique fields. `update` / `delete` work through the interface, applying each
  implementation's `onDelete` rules, as in the client.
- A union gets `<union>FindMany`, `<union>FindFirst`, `<union>Count` and, when members have indexes,
  `<union>Search` / `<union>FindSimilar`. Relations to a union take member-keyed nested writes
  (`picks: { connect: { Post: [{ id: "p1" }] } }`), and a nested `connect` inside a union
  `connect` applies its `where`, which is what `compat.v7` already does where v7 does not.

### Mutations

```graphql
type Mutation {
  postCreate(data: PostCreateInput!): Post
  postCreateMany(data: [PostCreateManyInput!]!): PostBatch
  postUpdate(where: PostWhereUnique!, data: PostUpdateInput!): Post
  postUpdateMany(where: PostWhere, data: PostUpdateManyInput!): PostBatch
  postUpsert(where: PostWhereUnique!, create: PostCreateInput!, update: PostUpdateInput!): Post
  postDelete(where: PostWhereUnique!): Post
  postDeleteMany(where: PostWhere): PostBatch
  …
}

type PostBatch {
  count: Int!
  "The affected records (as they were, for deleteMany). Loaded only when selected."
  nodes: [Post!]!
}
```

**Mutations return records.** Single-record mutations return the record (the deleted one for
`delete`, as the client does). Batch mutations return `count` and, when selected, the affected
records, read in the same statement (the client's `select` on `createMany` / `updateMany` /
`deleteMany`, [Runtime prerequisites](#runtime-prerequisites)). As implemented (#243): root fields
are nullable like the query ones (a failing field is `null` with its error, the others keep their
results), and `createMany` / `updateMany` take scalar-only inputs (`PostCreateManyInput`,
`PostUpdateManyInput`), since the client's batch operations take no relation writes.

**Nested writes** follow the client's relation operations:

```graphql
input PostCreateInput {
  id: ID
  title: String!
  body: String!
  published: Boolean
  views: Int
  author: UserCreateOneWithoutPostsRelation
  tags: TagCreateManyWithoutPostsRelation
}

input TagCreateManyWithoutPostsRelation {
  create: [TagCreateWithoutPostsInput!]
  connect: [TagWhereUnique!]
}

input UserUpdateManyWithoutFollowersRelation {
  create: [UserCreateWithoutFollowersInput!]
  connect: [UserConnectFollows!]
  disconnect: [UserWhereUnique!]
  set: [UserConnectFollows!]
}

input UserConnectFollows {
  id: ID
  email: String
  _edge: FollowsInput
}

input FollowsInput {
  since: DateTime
}
```

```graphql
mutation {
  userUpdate(
    where: { id: "u1" }
    data: {
      name: "Alice"
      _ops: { loginCount: { increment: 1 } }
      following: {
        connect: [{ email: "bob@acme.io", _edge: { since: "2026-11-01T00:00:00Z" } }]
        disconnect: [{ email: "carol@acme.io" }]
      }
    }
  ) {
    name
    following {
      email
      _edge {
        since
      }
    }
  }
}
```

- **`connect` is a `MERGE`** (the client's semantics, decided by the maintainer): connecting a pair that is
  already linked keeps one edge and updates the `_edge` properties passed; edge defaults are set
  only when the edge is created; on a to-one relation, `connect` replaces the edge; when the other
  side is to-one (connecting a post through `user.posts` while `Post.author` is `User?`), the post
  moves. Under concurrent writes it is still one edge (the `MERGE` locks the pair). Numeric `_edge`
  properties take `{ increment, decrement, multiply }` on `connect` / `set`, as in the client.
- `set`, `disconnect` (a list on to-many, `disconnect: true` on to-one) and nested `create` mean
  what they mean in the client. Inputs are generated per relation side (`TagCreateWithoutPostsInput`
  omits the back relation; the relation input is named after it,
  `<Target><Create|Update><One|Many>Without<Inverse>Relation`, or `Via<Edge>` when there is no
  back relation but a typed edge) only for operations that are enabled, so a read-only model
  generates no input types at all. `connect` items are the target's `WhereUnique`, or
  `<Target>Connect<Edge>` (the unique key plus `_edge`) on a typed edge.
- **Scalar updates.** A field in `PostUpdateInput` takes the new value, `null` removes the property
  (GraphQL distinguishes `null` from an absent key, and so does the client). Numeric operators go in
  `_ops` (`{ increment, decrement, multiply }`, Hasura's `_inc` idea), because GraphQL cannot accept
  either `3` or `{ increment: 1 }` for one field. Setting a field and an operator on it is a
  `BAD_USER_INPUT` error. Decided over `{ set, increment, … }` objects on every field (v7 style,
  more verbose).
- **Unique keys.** `PostWhereUnique` has every `@id` / `@unique` field (bare values) and
  composite key (`providerId_accountId: AccountProviderIdAccountIdKey`) as optional fields, plus
  the model's filters for its other fields (as the client allows extra filters next to the key); at least one key is required, checked by the client (`BAD_USER_INPUT`), since GraphQL
  cannot express "at least one of". `@oneOf` would express "exactly one" and lose the extra filters.
- Not in the client today, so not in the first version: nested `update`, `delete`, `upsert` and
  `connectOrCreate` (v7 has nested `update` / `delete`). They are added to the client first
  ([Runtime prerequisites](#runtime-prerequisites)), then exposed, so GraphQL never has a write the
  client does not.
- **Validation rules** (`@length`, `@min`, …) and enum checks run before anything is sent, as in the
  client; `issues` paths are translated to GraphQL argument paths (`["data", "tags", "create", 1,
"name"]`).
- A mutation response is read after every write of its statement, and applies the read rules
  (v7 does not on `create`).

### Operation toggles

v7's `@query(read: false)`, `@mutation(operations: [])`, `@selectable`, `@settable`, `@filterable`,
`@sortable` exist because a generated API exposes too much by default. Here they are config, typed,
and they remove fields and inputs from the schema (not just reject them at run time):

```ts
models: {
  AuditLog: { operations: { read: ["findMany", "count"], create: false, update: false, delete: false } },
  User: {
    operations: { create: false, delete: false, update: ["update"] }, // no updateMany / upsert
    fields: {
      passwordHash: false,                       // gone everywhere
      email: { filter: false, sort: false },     // readable, not usable to probe
      role: { create: false, update: false },    // never written through the API
      createdAt: { create: false, update: false },
    },
  },
},
defaults: { operations: { read: true, create: false, update: false, delete: false } },
```

- `operations` takes `true` / `false` or a list of client operations per group (`read`: `findUnique`,
  `findFirst`, `findMany`, `count`, `aggregate`, `groupBy`, `search`, `findSimilar`, `traverse`,
  `shortestPath`; `create`: `create`, `createMany`, `upsert`; `update`: `update`, `updateMany`,
  `upsert`; `delete`: `delete`, `deleteMany`). `upsert` needs both `create` and `update`.
- A model whose writes are off also loses the nested-write inputs that would write it through
  another model (`Tag` read-only means `PostCreateInput.tags` has `connect` but no `create`), which
  v7's `@mutation(operations: [])` does not do: there, a "read-only" type can still be created
  through a nested `create`. That is the security-relevant part.
- `fields.<f>.read: false` (alias `false`) hides a field; `filter` / `sort` / `create` / `update`
  toggle the rest. A required field without a default that cannot be written makes `create` of the
  model impossible: `makeSchema` reports it unless `create` is off.
- **Default** (decided): reads on, writes off, so a model is only writable through the API once
  someone decided it should be.

## Auth

### Authentication

`makeSchema` does not verify tokens itself in the native API: the server's context function does
(`context: async ({ request }) => ({ user: await verify(request) })`), and the context type `Ctx`
of `defineGraphQL` types what rules see. For parity with `compat.v7`, `native.jwtContext({ key })`
builds such a context from the `Authorization` header (the same `jose` verifier as
`features.authorization`), so both APIs can share one context function.

`authenticated` is a per-model or per-operation flag: `models.Post.authenticated: { create: true }`
fails those operations with `UNAUTHENTICATED` before anything runs, when `ctx.user` (configurable:
`isAuthenticated: (ctx) => boolean`) is missing.

### Rules: schema-level, compiled into the statement

A rule is a TypeScript function of the request context that returns `true` (allowed), `false`
(denied) or a `where` on the model (allowed for the nodes it matches), typed as the client's
`WhereInput` of that model:

```ts
rules: {
  read:   ({ ctx }) => …,        // findMany, findUnique, count, aggregate, groupBy, search, traverse,
                                 // relation loads, relation filters, _count, mutation responses
  create: ({ ctx, data }) => …,  // boolean only, on the input (pre-checked), plus `after`
  update: ({ ctx }) => …,        // restricts the nodes an update matches
  delete: ({ ctx }) => …,        // restricts the nodes a delete matches
  connect:    { tags: ({ ctx }) => … },  // per relation, on the target
  disconnect: { tags: ({ ctx }) => … },
  after:  { create: ({ ctx }) => …, update: ({ ctx }) => … }, // checked in the statement, after the write
}
```

- **Compiled, not filtered in JavaScript.** A `where` rule is ANDed into the client `where` of every
  place the model is matched: the root, every nested relation load, every relation filter
  (`some` / `none` / `every` / `is`), `_count`, aggregates, traversal and search hits, nested write
  targets. It is the same compiler as the client's `where`, so a rule can use relations, `_on`,
  `_labels`, anything a `where` can. Values from the context are parameters.
- **What it fixes over v7.** Filters and sorting cannot probe hidden nodes or fields (they only see
  readable ones); one `read` rule covers lists, counts and aggregates (no `AGGREGATE` rule to keep in
  sync); `update` applies whatever the update writes, scalar fields or relations only; the
  `create` response applies `read`; rules are type-checked against `schema.cyphra` and never parsed
  from strings.
- **Denied vs not found.** An `update` / `delete` on a node outside the rule fails with `NOT_FOUND`
  (the node does not exist for this request), not `FORBIDDEN`, so a rule does not reveal that a key
  exists. `false` (the whole operation denied) is `FORBIDDEN`. `after` rules failing are `FORBIDDEN`
  and roll the statement back, like v7's `validate: AFTER`.
- **Relationship rules.** `connect` / `disconnect` rules restrict the targets; connecting also
  requires `update` on the source (unlike v7's relationship-only updates).

### Field rules

`fields.email.read: ({ ctx }) => boolean` is a context-only predicate, evaluated once per request
before the statement is built: a denied field selected is `null` with a `FORBIDDEN` error at its
path (the field is generated nullable), and a denied field used in `where` / `orderBy` / `groupBy`
fails the root field with `FORBIDDEN`. **Row-dependent field rules** ("email readable by its
owner") are in the first version (decided):
`read: { where: ({ ctx }) => ({ id: ctx.user?.id }) }`, compiled to
`CASE WHEN <where> THEN n.email END`, so the field is `null` on the rows the `where` does not
match, and the same `where` guards the field in filters and ordering.

### Hooks via `$extends`

Rules are declarative and reach every place a model appears in a statement. Hooks are code around
one client operation. Both are needed, and they do different jobs:

- `client` may be a function of the context: `client: (ctx) => db.$extends(tenantScope(ctx.tenant))`.
  Every root field runs through that client, so **query hooks fire** (`post.findMany`,
  `user.create`, `$allOperations`: soft delete, hashing a password, audit logs, multi-tenancy that
  rewrites `where`), and hook-replaced operations (soft delete turning `delete` into `update`) are
  what GraphQL runs.
- Hooks wrap the **root** operation only, as in the client: `user.findMany` with `posts` in the
  selection does not call `post.findMany` hooks. So a hook is not a substitute for a read rule on
  `Post`; the docs say so in one sentence and the config has the rule.
- Hooks see the client arguments the GraphQL layer built (including the `select` of the whole
  selection), and `getExtensionContext` exposes `ctx.graphql` (`{ info, context }`) for hooks that
  need the request.
- Per-request `$extends` must be cheap (it is a few object allocations today; a benchmark is part
  of phase 1).

## Custom resolvers and computed fields

A real app does not live on generated CRUD alone. The dry run on an existing v7 app needed:
dashboard queries returning non-node types, mutations with business logic, a field computed in
JavaScript, and fields backed by Cypher (v7 `@cypher`).

### Computed fields from `$extends({ result })`

Computed fields of the client are exposed by naming their GraphQL type (the client knows their
TypeScript type, but not at run time):

```ts
computed: { User: { fullName: "String!" } },
```

`fullName` appears on `User`, its `needs` are added to the statement's projection when selected,
and `compute` runs on each result after decoding, as in the client. It cannot be filtered or
sorted on (it does not exist in the database). The declared GraphQL type is checked against the
`compute` return type through the config's generics where TypeScript allows it.

### Cypher-backed fields

The `@cypher` equivalent, declared in TypeScript and compiled as a subquery of the parent's
statement (so still one statement), with typed arguments and parameters only:

```ts
cypherFields: {
  User: {
    followerCount: {
      type: "Int!",
      args: { since: "DateTime" },
      cypher: ({ node, args }) => cypher`COUNT { (${node})<-[f:FOLLOWS]-() WHERE f.since >= ${args.since} }`,
    },
  },
},
```

Such fields can be selected, and (when they return a scalar) filtered and sorted on, as v7 allows.
They come after computed fields in the plan (phase 7).

### Custom root fields and non-node result types

Custom operations are plain SDL plus resolvers, merged into the generated schema. They may return
generated types, their own object types, or a mix:

```ts
extend: {
  typeDefs: /* GraphQL */ `
    type DashboardStats {
      postsThisWeek: Int!
      topAuthors: [User!]!
    }
    extend type Query {
      dashboard: DashboardStats!
      semanticSearch(text: String!, take: Int = 10): [Chunk!]!
    }
    extend type Mutation {
      publishPost(id: ID!): Post!
    }
  `,
  resolvers: {
    Query: {
      dashboard: () => ({}), // fields below
      semanticSearch: async (_, { text, take }, ctx, info) =>
        ctx.cyphra.chunk.findSimilar({
          field: "embedding",
          vector: await embed(text),
          k: take,
          ...ctx.cyphra.selection(info), // the GraphQL selection as client select, rules applied
        }),
    },
    DashboardStats: {
      postsThisWeek: (_, __, ctx) => ctx.cyphra.post.count({ where: { createdAt: { gte: weekAgo() } } }),
      topAuthors: (_, __, ctx, info) =>
        ctx.cyphra.user.findMany({
          orderBy: [{ posts: { _count: "desc" } }],
          take: 5,
          ...ctx.cyphra.selection(info),
        }),
    },
    Mutation: {
      publishPost: (_, { id }, ctx, info) =>
        ctx.cyphra.post.update({ where: { id }, data: { published: true }, ...ctx.cyphra.selection(info) }),
    },
  },
},
```

- `ctx.cyphra` is the request's client **with the API's rules applied** (a `$extends` built from
  the config), so a custom resolver cannot read around a read rule by accident; `ctx.cyphra.$unsafe`
  is the raw client for the rare resolver that must.
- `ctx.cyphra.selection(info)` turns the selection under a generated type into the client's
  `select` (with `_edge`, fragments, `_count`, computed and Cypher fields), so a custom resolver
  returning `[User!]!` loads exactly what was asked in one statement: no N+1 for nested fields.
- Non-node types (`DashboardStats`) are ordinary GraphQL: their field resolvers run as GraphQL
  runs them. Each field that calls the client is one statement; use DataLoader there if a list of
  them is resolved (nothing magic).
- The extension SDL is validated at startup against the generated schema (an `extend type User`
  field colliding with a generated one is an error) and is part of the printed contract.

## One statement per root field

The resolver of a generated root field:

1. Checks `authenticated` and the operation toggle.
2. Translates `args` and the selection set (`info.fieldNodes`, fragments resolved, `@include` /
   `@skip` applied, variables substituted) into one client operation's arguments, ANDing the rules
   in. Every name is checked against the schema (it already passed GraphQL validation; the client
   checks again).
3. Calls that operation on the request's client (hooks run), which compiles **one Cypher
   statement** (`COLLECT {}` / `COUNT {}` subqueries for relations, `CASE WHEN n:Label` for
   fragments) in its own transaction, read or write.
4. Maps the decoded result back onto response keys (aliases), and runs computed fields.

Nested fields of generated types have no resolver doing I/O (`byResponseKey`, as in `compat.v7`),
so a query is as many statements as it has root fields, whatever its depth.

**Aliases.** GraphQL allows the same field twice with different arguments
(`recent: posts(take: 3)` and `popular: posts(orderBy: [{ views: desc }], take: 3)`). The client's
`select` has one key per relation, so the translator needs an aliased form of a relation load. This
is an internal entry point of the runtime engine (`select: { recent: { $relation: "posts", … } }`,
not part of the public client types), see [Runtime prerequisites](#runtime-prerequisites).

**Statement size.** A deep selection is a large statement. `config.limits` sets `maxDepth`,
`maxTake` (default `take` and the cap), `maxAliases` and a complexity budget (relations × take),
checked before the statement is built; exceeding one is `BAD_USER_INPUT` with the limit named.

**Mutations and transactions.** Each root field is its own transaction (decided; as in v7 and
`compat.v7`).
`config.mutationTransaction: "request"` runs every root field of one mutation operation in a single
write transaction (one statement each, serially, as the GraphQL spec orders them), so
`mutation { a: postCreate(…) b: tagCreate(…) }` commits both or neither. v7 has no equivalent.

## Errors

Errors are GraphQL errors with a stable `extensions.code`, mapped from the client's error classes:

| Client error                      | `extensions.code`       | `extensions`                                                                        |
| --------------------------------- | ----------------------- | ----------------------------------------------------------------------------------- |
| `CyphraValidationError`           | `BAD_USER_INPUT`        | `issues: [{ path, model, field, rule, message }]` (paths in GraphQL argument terms) |
| `NotFoundError`                   | `NOT_FOUND`             | `model`                                                                             |
| `RestrictError`                   | `RESTRICTED`            | `model`, `relation`, `target`, `count`                                              |
| `UniqueConstraintError`           | `UNIQUE_CONSTRAINT`     | `model`, `fields`, `constraint` (never the value)                                   |
| authentication missing            | `UNAUTHENTICATED`       |                                                                                     |
| rule denied / `after` rule failed | `FORBIDDEN`             | `model`, `operation` (field rules: `field`)                                         |
| config limit exceeded             | `BAD_USER_INPUT`        | `limit`                                                                             |
| anything else (driver, bug)       | `INTERNAL_SERVER_ERROR` | message masked unless `debug: true`                                                 |

- A failing root field is `null` with its error; other root fields of a query still return (GraphQL
  semantics). With `mutationTransaction: "request"`, the first failure rolls back and the remaining
  mutation fields are not run (each gets the same error, so clients see why).
- `UniqueConstraintError` is mapped here, unlike `compat.v7`, which leaves Neo4j errors as v7 does.
- An invalid cursor, an `_edge` outside its context, two keys in one `orderBy` element, a field and
  an `_ops` operator on the same field: `BAD_USER_INPUT`, before any statement runs.

## Subscriptions (hook-in for #76)

#76 brings CDC-based subscriptions to `compat.v7` (`movieCreated`, `movieUpdated`, `movieDeleted`,
relationship events). The native API reuses its CDC reader and adds typed, rule-aware events:

```graphql
type Subscription {
  postChanged(where: PostWhere, operations: [ChangeOperation!]): PostChange!
}

type PostChange {
  operation: ChangeOperation! # CREATED, UPDATED, DELETED
  "The node after the change, projected with the selection and the read rule. Null for DELETED."
  node: Post
  "Changed property names (UPDATED)."
  changedFields: [String!]!
  "Key of the node, always present, also for DELETED."
  id: ID!
}
```

- One shared CDC poller per server (`db.cdc.query` from the cursor of #76), fanning out to
  subscribers. For each batch, every subscription re-reads its nodes with **one statement**:
  `findMany({ where: { AND: [{ id: { in: ids } }, sub.where, readRule(sub.ctx)] }, select })`, so
  an event is delivered only if the subscriber may read the node _now_, and with exactly its
  selection. `DELETED` events carry only the key (the node is gone; delivering its old properties
  would bypass read rules). Relation events (`userFollowingConnected` / `…Disconnected`, with
  `_edge`) come in the same phase.
- Hosting constraints are those documented by #76 (long-lived connections, not serverless
  functions). Subscription fields are off by default (`operations: { subscribe: true }`).
- Scope: the generated `Subscription` type is designed now so the contract does not change later;
  implementation waits for #76's reader.

## Coexistence with `compat.v7` and migration

### Side by side

Both schemas are built from the same graph: `compat.v7` from `typeDefs.graphql`, the native one from
`schema.cyphra` (which `cyphra import graphql` produced from the same type definitions). They share
one driver or client:

```ts filename="app/api/graphql/[[...v]]/route.ts"
const v7 = compat.v7.makeSchema({ typeDefs, client: db, features: { authorization: { key } } });
const api = native.makeSchema({ client: db, config });

// /api/graphql stays the v7 API; /api/graphql/v2 is the native one.
export const { GET, POST } = routeBySegment({ "": yoga(v7), v2: yoga(api) });
```

- **Separate endpoints** (decided): the two schemas have types with the same names (`User`,
  `Post`) and different shapes, and frontends move operation by operation. One schema with a
  `typePrefix` option was rejected.
- Both run on one client, so `query` events, OpenTelemetry spans and missing-index warnings cover
  both APIs. The native API runs the client's hooks; `compat.v7` does too once it is on the shared
  engine (phase 4), and until then compiles its own statements.
- Auth: the v7 rules stay in `typeDefs.graphql` for `/api/graphql`; the native API needs its rules
  in `graphql.config.ts` before writes are enabled there. `cyphra graphql migrate-rules` prints a
  draft translation of each `@authorization` rule into a native rule (`"$jwt.sub"` → `ctx.jwt.sub`,
  `single` → `is`, `filter` → `read` / `update` / `delete`), flagged for review: a draft, never
  applied automatically, because the semantics differ on purpose.

### Mapping table v7 → native

| v7 (`compat.v7`)                                                                              | Native                                                                                                                           |
| --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `movies(where, sort, limit, offset)`                                                          | `movieFindMany(where, orderBy, take, skip) { nodes }`                                                                            |
| `moviesConnection(first, after, sort, where) { edges { node } totalCount pageInfo }`          | `movieFindMany(take, after, orderBy, where) { nodes totalCount pageInfo }` (keyset cursors: not interchangeable with v7 cursors) |
| `actorsConnection { edges { properties { role } node { name } } }`                            | `actors { name _edge { role } }`                                                                                                 |
| `where: { title: { eq: "x" } }`, `title_EQ` (deprecated)                                      | `where: { title: { equals: "x" } }`                                                                                              |
| `{ in }`, `{ contains }`, `{ startsWith }`, `{ lt }`, …                                       | same names (`in`, `contains`, `startsWith`, `lt`, …)                                                                             |
| `{ title: { eq: null } }`                                                                     | `{ title: null }`                                                                                                                |
| `actors: { some / all / none / single: … }`                                                   | `actors: { some / every / none: … }`; `single` has no equivalent (count it: see below)                                           |
| to-one `author: { single: … }` (v7 lists)                                                     | `author: { is: … }`                                                                                                              |
| `actorsAggregate: { count: { gt: 2 } }` (aggregation filter)                                  | not in the first version (needs `_count` filters in the client `where`)                                                          |
| `sort: [{ title: ASC }]`                                                                      | `orderBy: [{ title: asc }]`                                                                                                      |
| `moviesConnection { aggregate { count { nodes } node { year { average } } } }`                | `movieAggregate { _count { _all } _avg { year } }`                                                                               |
| `createMovies(input: [...]) { info { nodesCreated } movies { … } }`                           | `movieCreate(data)` / `movieCreateMany(data) { count nodes { … } }`                                                              |
| `updateMovies(where, update: { title: { set: "x" } })`                                        | `movieUpdate(where: unique, data: { title: "x" })` or `movieUpdateMany(where, data)`                                             |
| `update: { year: { add: 1 } }`                                                                | `data: { _ops: { year: { increment: 1 } } }`                                                                                     |
| `deleteMovies(where, delete: { actors: … }) { nodesDeleted }`                                 | `movieDelete(where)` / `movieDeleteMany(where) { count nodes }`; nested delete: `onDelete: Cascade` in `schema.cyphra`           |
| nested `connect: [{ where: { node: { name: { eq: "x" } } }, edge: { role } }]`                | `connect: [{ name: "x", _edge: { role } }]` (unique keys only, and a `MERGE`)                                                    |
| nested `connect` by a non-unique `where` (many nodes)                                         | not supported: connect by key, or a custom mutation                                                                              |
| nested `update` / `delete`                                                                    | phase 8 (client first); until then root mutations or a custom resolver                                                           |
| `@fulltext` query `moviesByTitle(phrase)` with `score`                                        | `movieSearch(index, query, mode) { _score }`                                                                                     |
| `@cypher` field                                                                               | `cypherFields` (phase 7)                                                                                                         |
| `@authorization` / `@authentication`                                                          | `rules` / `authenticated` in TypeScript                                                                                          |
| `@query`, `@mutation(operations: [])`, `@selectable`, `@settable`, `@filterable`, `@sortable` | `operations` and `fields` toggles                                                                                                |
| `@plural`                                                                                     | not needed; `naming` overrides single names                                                                                      |
| union `contents(where: { Movie: … })`                                                         | `contentFindMany(where: { _on: { Movie: … } })`                                                                                  |
| v7 interfaces (no label)                                                                      | Cyphra interfaces (a shared label, backfilled by a migration)                                                                    |
| `@id` (UUID), `@timestamp`                                                                    | `@default(uuid())`, `@default(now())` / `@updatedAt`                                                                             |

### Codemod and dual-run check

- `cyphra graphql migrate-operations "src/**/*.{graphql,ts,tsx}"` rewrites operation documents
  (`.graphql` files and `gql` / `graphql` tagged templates) from the v7 API to the native one, using
  the type information of both schemas: renames root fields, rewrites `where` / `sort` / paging /
  connections / mutation inputs per the table, and leaves a `# cyphra: …` comment on what it cannot
  translate (aggregation filters, `single`, connect by non-unique `where`, nested update/delete,
  v7 cursors stored by clients). It changes documents only; generated client types are rebuilt by
  the app's own codegen.
- **Dual-run**: `cyphra graphql compare --v7 typeDefs.graphql --native config.ts ops/` runs each
  operation against both schemas on a disposable database (the `compat/graphql` runner: reset, seed,
  run, normalize) and diffs the normalized results, operation by operation, after the codemod. Known
  semantic differences (duplicate edges on connect, `some: {}`, rules in filters) are reported as
  such, not as failures. This is the migration guide's "run the compatibility suite against your
  own operations" step, extended to the native API, and closes the follow-up comment on #77 (extend
  `/guides/migrate-from-neo4j-graphql`, section "Next: the native API").

### Divergences we already have

The two `compat/graphql` checks that fail on purpose (`media/14-connect-nested-union`,
`media/15-disconnect-nested-union`: v7 ignores the `where` of a union `connect` / `disconnect`
nested in another one) are the native behaviour, and stay listed as deliberate in
`cyphra-expected.json`. Moving `compat.v7` onto the shared engine does not change its behaviour:
in particular `compat.v7` keeps v7's duplicate-edge `connect`, and the golden suite checks it.

## Versioning and the printed contract

- **Deterministic SDL.** The generated schema is printed with `lexicographicSortSchema` +
  `printSchema` (as the compat goldens are), descriptions included, so it diffs cleanly.
  `cyphra graphql print [--out schema.graphql]` writes it from `schema.cyphra` and the config;
  `cyphra graphql print --check` fails when the committed file differs (for CI), and prints
  `findBreakingChanges` / `findDangerousChanges` from graphql-js between the two, so a field removed
  by a schema edit or a toggle is visible in review.
- **Generator versions.** What the generator emits for a given `schema.cyphra` and config is the
  contract. `defineGraphQL({ generator: 1, … })` pins it; a release of `@cyphra/graphql` that would
  print a different SDL for the same input (new naming, nullability, a new default) ships it as
  `generator: 2`, opt-in, with the old one kept for at least one major. Additive changes (a new
  operation on a feature that did not exist) are allowed within a generator version only when off
  by default.
- **Deprecations.** A model field to be removed is marked `deprecated: "use x"` in `fields` (or by
  a doc comment in `schema.cyphra` if the language gets `///` comments), which emits
  `@deprecated(reason)`; removing it is then a reviewed breaking change in the printed SDL.
- **Snapshot tests.** Each fixture of a new `compat/graphql`-style native suite has a golden
  `schema.graphql`, so generator changes show up as golden diffs in PRs, like v7 bumps do today.

## Runtime prerequisites

The native API never does what the client cannot, so some work lands in `@cyphra/runtime` first,
each useful on its own:

1. **Keyset cursors** in `findMany` (`cursor: { after?, before? }`, opaque, tied to `orderBy`).
   Landed (#239): `select: { $cursor: true }` returns each row's cursor.
2. **Aliased relation loads** (internal engine entry, not public types) for GraphQL aliases.
   Landed (#239): `select: { recent: { $relation: "posts", take: 3 } }`.
3. **`select` on `createMany` / `updateMany` / `deleteMany`**, returning `{ count, nodes }`.
   Landed (#243): `nodes` are read in the same statement (deleted nodes as they were).
4. **Rule injection**: an engine option that ANDs a per-model `where` into every match of that
   model in a statement (root, relation loads, relation filters, `_count`, aggregates, write
   targets). This is also what `ctx.cyphra` uses, and could become a public `$extends` feature
   ("row-level rules") for TypeScript users. Landed (#239) as `withEngineRules(client, rules)`
   (internal): evaluated `read` / `update` / `delete` rules per model; the GraphQL layer evaluates
   the context functions per request and passes the result. Extended for phase 5 (#245) with
   `create` (boolean or function of the data), `connect` / `disconnect` per relation, `after`
   (`create` / `update`, checked in the statement, rolled back otherwise) and per-field read rules
   (`fields`, `CASE WHEN`). Per-request `$extends` costs about
   2.5 µs on a 4-model schema and 45 µs on a 100-model one (`pnpm --filter cyphra-bench extends`).
5. **Edge filters and ordering on relation loads** (`_edge` in `some` / `orderBy`) where the client
   does not have them yet.
6. Later: nested `update` / `delete` / `upsert` / `connectOrCreate`; `_count` filters in `where`
   (for v7 aggregation filters).

## Decisions

The open questions of the review, as decided by the maintainer:

1. **Root field names**: `postFindMany` / `postCreate` (`<delegateKey><Operation>`, no
   pluralization; `naming` overrides cover the few that read badly).
2. **Default exposure**: reads on, writes off.
3. **Scalar updates**: plain values, plus `_ops` for numeric operators.
4. **List result**: `PostList { nodes pageInfo totalCount }`, one list query for offset and cursor
   paging.
5. **`_edge` with several relationship models** targeting one node type: a union (`UserEdge`),
   selected with inline fragments.
6. **Row-dependent field rules** (`email` readable by its owner): in the first version.
7. **Config**: TypeScript only (`graphql.config.ts`), no schema attributes in `schema.cyphra`.
8. **Endpoints**: separate endpoints for `compat.v7` and native.
9. **Relay**: an opt-in `Node` interface with global ids and `node(id: ID!)` (`relay: true`), off
   by default.
10. **Mutation transactions**: one per root field by default (`mutationTransaction: "request"`
    opts in to one per request).
11. **Package layout and architecture**: one engine, native at the core and `compat.v7` a thin
    translation layer on top, both in `@cyphra/graphql` (`import { compat, native }`); see
    [Architecture](#architecture-one-engine).
12. **`findFirst` / `count` root fields**: kept, for parity with the client.
13. **`connect` in native**: a `MERGE`.

## Implementation plan (candidate sub-issues)

Each phase ends with docs and tests; the native suite (`compat/graphql`'s runner with native
fixtures and goldens: printed SDL plus results) grows with it.

1. **Runtime prerequisites, part 1**: keyset cursors in `findMany`, aliased relation loads (internal),
   rule injection in the engine. Benchmark per-request `$extends`.
2. **Native read API**: `native.makeSchema`, `defineGraphQL` (typed config, startup checks), naming,
   object types, `findUnique` / `findFirst` / `findMany` (offset + cursor) / `count`, filters,
   ordering, relations with `_edge`, `_count`, interfaces and unions (fragments → `$on`), scalars,
   operation and field toggles, limits, error mapping, opt-in Relay `Node` (`relay: true`),
   `cyphra graphql print [--check]`.
3. **Native write API**: `create` / `createMany` / `update` / `updateMany` / `upsert` / `delete` /
   `deleteMany` returning records (with `select` on batch operations in the client), nested
   `create` / `connect` (MERGE) / `disconnect` / `set`, `_ops`, validation issue paths,
   `mutationTransaction: "request"`.
4. **`compat.v7` on the shared engine**: rewrite `compat.v7` as a translation layer (v7 request →
   native / client call → v7-shaped response), operation family by family, with the golden suite
   green at every step. v7 features whose engine pieces come in later phases (aggregations,
   fulltext, `@cypher`, `@authorization`) keep the current compat compiler until those land. The
   compat gaps #223–#229 are fixed in the current compiler before this phase.

   Status (#244): moved, each request checked before it runs (anything the engine cannot answer
   exactly like v7 runs on the compat compiler): list and connection queries (filters, sorting,
   `limit` / `offset` and v7 offset cursors, nested relationships and connections with edge
   `properties`), `create` with attribute inputs, `update` with `set`, `delete` without nested
   deletes. Staying on the compat compiler, with the reason: aggregations, fulltext, `@cypher`,
   `@authentication` / `@authorization` and subscriptions (later phases); interfaces (v7
   interfaces add no label) and unions; edge filters and sorts (runtime prerequisite 5); `single`
   (no count filter in the client `where` yet); nested writes (`connect` is a v7 `CREATE`, the
   engine's a `MERGE`; nested `update` / `delete` are phase 8); arithmetic and list operators and
   `field_SET` keys (v7-specific errors); `@timestamp` and `@limit` types in mutations (v7 writes
   the database clock and limits the returned nodes); DateTime values in filters and inputs (v7
   keeps their offset and precision); requests with `context.cypherParams`. Engine entries added
   for it, internal: `withRawValues(client)` (driver values, shaped by the v7 decoders) and
   `deleteMany({ $relationships: true })` (v7's `relationshipsDeleted`).

5. **Auth**: `rules` (read / create / update / delete / connect / disconnect / after),
   `authenticated`, field rules (context-only and row-dependent), `native.jwtContext`,
   `ctx.cyphra`, a security test per v7 footgun fixed.

   Status (#245): landed. Choices made where this note left them open: a node the request cannot
   `read` does not exist for `update` / `delete` / `connect` / `disconnect` either (`NOT_FOUND`);
   a written node the `read` rules hide is returned as `null` (the write happened; batch `nodes`
   leave it out); connecting through a to-many side whose inverse is to-one applies the target's
   `update` rule; explicit `disconnect` / `set` leave edges outside the `disconnect` rule alone,
   while a to-one edge a write must replace outside it is `FORBIDDEN`; `upsert` checks the
   `create` rule whether it creates or updates; a whole `authenticated` group also hides the
   model (or blocks its nested writes) for anonymous requests, an operation list only guards root
   fields; `native.jwtContext` returns `{ token, jwt, user }` (the default `isAuthenticated` is
   "has a `user` or a `jwt`"); `ctx.cyphra` is set by `native.context(schema, build)` or by the
   first generated root field of the request; field rules cannot target the `@id` field, and
   row-dependent ones are for scalars; `after` / `disconnect` rules are refused on FalkorDB (no
   rollback). TypeScript checks the object a rule returns only partly (a misspelled key next to a
   valid one passes `tsc`), so `makeSchema` also calls each `where` rule with an empty context and
   checks what it returns.

6. **Aggregates, groupBy, search, findSimilar, union search, traversals** (`<model>Traverse`,
   `TraversePaths`, `ShortestPath`, named traversal fields).
7. **Extension points**: computed fields, `extend` SDL + resolvers, `ctx.cyphra.selection(info)`,
   Cypher-backed fields.
8. **Runtime prerequisites, part 2 + exposure**: nested `update` / `delete` / `upsert` /
   `connectOrCreate`, `_count` filters in `where`.
9. **Migration tooling**: mapping table in the docs, `cyphra graphql migrate-operations`,
   `cyphra graphql compare` (dual-run), `migrate-rules` drafts, the "Next: the native API" section of
   `/guides/migrate-from-neo4j-graphql` (follow-up comment on #77).
10. **Subscriptions** on #76's CDC reader: `<model>Changed`, relationship events, rule-aware
    re-reads.

Acceptance criteria of #77 map to phases 2 (both modes served side by side, with a test serving
both from one server), 5 (typed rules fail at build time on unknown fields: a `test-d.ts` with
`@ts-expect-error`, plus the startup check) and this document (reviewed before implementation).
