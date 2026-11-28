---
title: "Typed Neo4j queries in TypeScript with Cyphra"
description: "Why Neo4j results lose their types in TypeScript, and how Cyphra's generated client infers them from one .cyphra schema, from filters to edge properties."
date: "2026-11-18"
author: "Cyphra team"
tags: ["typescript", "neo4j", "typed-client", "cypher"]
---

Every Neo4j project in TypeScript starts the same way. You install `neo4j-driver`, write a Cypher
string, run it, and get back a list of `Record` objects. Each value you read is `any` until you cast
it, integers come back as the driver's `Integer` type, dates as Neo4j temporal objects, and nothing
tells you that `u.emial` is a typo until production does.

Cyphra fixes this at the source. You describe the graph once, in a `.cyphra` schema, and
`cyphra generate` writes a client whose arguments and results are typed from that schema. This post
walks through how that works, what the types look like, and where raw Cypher still fits.

## Where the types get lost

The Neo4j JavaScript driver is a protocol client: it sends Cypher over Bolt and decodes what comes
back. It does not know your labels, your properties or which relationships connect which nodes,
because Neo4j itself does not require any of that to be declared. A query returns whatever its
`RETURN` clause says, and the compiler has nothing to check it against.

The usual workarounds each cover part of the problem:

- **Hand-written interfaces** next to each query. They drift as soon as someone renames a property.
- **Casting** `record.get("u")` to a type. The cast always compiles, whether it is right or not.
- **String building** for optional filters. Easy to get wrong, and a short step from injecting user
  input into Cypher.

What is missing is a single description of the graph that both the database and the compiler can
read. That is the schema.

## One schema for the graph

A Cyphra schema lists node models, their properties, and the relationships between them. Here is
the one used on the Cyphra landing page:

```cyphra filename="schema.cyphra"
node User {
  id        String  @id @default(cuid())
  email     String  @unique
  name      String?
  posts     Post[]  @relationship(type: "AUTHORED", direction: OUT)
  following User[]  @relationship(type: "FOLLOWS", direction: OUT)
}

node Post {
  id        String  @id @default(uuid())
  title     String
  published Boolean @default(false)
  author    User?   @relationship(type: "AUTHORED", direction: IN)
}

relationship Follows {
  type "FOLLOWS"
  from User
  to   User
  since DateTime @default(now())
}
```

Each `node` becomes a Neo4j label. Each relation field names a relationship type and a direction,
so `posts` and `author` are the two ends of the same `:AUTHORED` edge. The `relationship Follows`
block gives the `:FOLLOWS` edge its own typed property, `since`. The same file drives
[constraints and indexes](/schema) and [migrations](/migrations), so the types and the database
cannot disagree about what a `User` is.

## What `cyphra generate` writes

Run `npx cyphra generate` and Cyphra writes `cyphra.gen.ts`. For the schema above, the model types
look like this (excerpt of the real output):

```ts filename="cyphra.gen.ts"
/** `User` node properties. */
export type User = {
  id: string;
  email: string;
  name: string | null;
};

/** `Follows` (`:FOLLOWS`) edge properties. */
export type Follows = {
  since: Date;
};

export type CyphraTypeMap = {
  User: {
    scalars: User;
    createRequired: "email";
    unique: "id" | "email";
    relations: {
      posts: { target: "Post"; many: true; optional: false; edge: null };
      following: { target: "User"; many: true; optional: false; edge: Follows };
    };
  };
  // ...
};
```

Notice what the generator already decided for you. `name` is optional in the schema, so it is
`string | null`. `email` is the only field you must pass on create, because `id` has a default.
`id` and `email` are the unique keys, which is what `findUnique` will accept. And `following`
carries an edge type, `Follows`, because a relationship model with the same type and endpoints
exists.

You create the client from the generated module:

```ts filename="db.ts"
import { createClient } from "./cyphra.gen.js";

export const db = createClient({
  uri: process.env.NEO4J_URI!,
  user: process.env.NEO4J_USERNAME!,
  password: process.env.NEO4J_PASSWORD!,
});
```

Each node model becomes a delegate with a lower-cased name: `db.user`, `db.post`.

## Reading: filters and result types

Filters are objects shaped by the field types. Strings get `contains`, `startsWith` and
`endsWith`; numbers and dates get `lt`, `lte`, `gt` and `gte`; to-many relations get `some`,
`none` and `every`:

```ts
const users = await db.user.findMany({
  where: { email: { endsWith: "@acme.io" }, posts: { some: { published: true } } },
  take: 20,
});
// users: User[]
```

Misspell a field, or use `startsWith` on a `Boolean`, and it is a compile error. The same checks run
at runtime too, so an unknown key from untyped input throws a `CyphraValidationError` instead of
reaching the database.

The result type follows the arguments. `include` adds relations to all scalar fields, and `select`
picks exactly what you ask for, at any depth:

```ts
const user = await db.user.findUnique({
  where: { id },
  select: {
    name: true,
    posts: {
      where: { published: true },
      orderBy: { title: "asc" },
      take: 5,
      select: { title: true },
    },
    following: true,
  },
});
// { name: string | null; posts: { title: string }[]; following: (User & { $edge: Follows })[] } | null
```

Two details are worth pointing out. `findUnique` only accepts `id` or `email` in `where`, because
those are the unique fields; passing `name` does not type-check. And each followed user carries the
properties of the `:FOLLOWS` edge under `$edge`, so `user.following[0].$edge.since` is a `Date`.

Under the hood, a read like this is a single Cypher query. The client compiles relations into a map
projection with nested `COLLECT { … }` subqueries. Simplified, the `following` part reads:

```cypher
MATCH (n:`User`) WHERE n.`id` = $p0
RETURN n{.`name`, `following`: COLLECT {
  MATCH (n)-[r1:`FOLLOWS`]->(m0:`User`)
  RETURN m0{.`id`, .`email`, .`name`, `$edge`: properties(r1)}
}} AS row
```

That is why the typed client needs Neo4j 5.6 or later: `COLLECT {}` and `EXISTS {}` subquery
expressions are what keep it to one round trip per read.

## Writing: nested writes in one transaction

Writes use the same model types. A create can make related nodes and connect existing ones in the
same call, including edge properties:

```ts
// `email` and `bobEmail` come from your signup form, for example.
const alice = await db.user.create({
  data: {
    email,
    posts: { create: [{ title: "Graphs are everywhere" }] },
    following: { connect: { email: bobEmail, $edge: { since: new Date() } } },
  },
  include: { posts: true, following: true },
});
```

A nested write runs in one write transaction: if any step fails, for example because the `connect`
target does not exist, nothing is written. Schema defaults are applied on create, so `id` gets a
cuid and `published` starts as `false`.

For several operations that must succeed together, `$transaction` hands you a client bound to one
transaction. Here with an `Account` model that has an `Int` balance:

```ts
await db.$transaction(async (tx) => {
  const from = await tx.account.update({ where: { id: a }, data: { balance: { decrement: 10 } } });
  if (from.balance < 0) throw new Error("insufficient funds"); // rolls everything back
  await tx.account.update({ where: { id: b }, data: { balance: { increment: 10 } } });
});
```

The driver may retry the callback on transient errors, so keep it free of outside side effects.

## When Cypher is the better tool

An OGM should not stand between you and the query language. Aggregations, variable-length paths and
graph algorithms are often clearer in Cypher, so Cyphra keeps it one call away:

```ts
const rows = await db.$cypher<{ name: string; n: number }>`
  MATCH (u:User)-[:AUTHORED]->(p:Post) WHERE p.published = ${true}
  RETURN u.name AS name, count(p) AS n ORDER BY n DESC
`;
```

`$cypher` is a tagged template: every interpolated value becomes a query parameter, never part of
the query text. Results are converted to plain JavaScript (integers to `number`, temporals to
`Date`, nodes to their properties). The type parameter is a declaration rather than a check, so
keep these queries small and close to where they are used.

When you want composable queries without the OGM, the [query builder](/queries) and the
[runtime](/runtime) are the layers underneath, and they are exported from the same `cyphra`
package.

## Values and safety

Two properties of the client matter beyond convenience:

- **Value mapping is explicit.** `Int` is a 64-bit integer in Neo4j and a `number` in TypeScript;
  values outside the safe integer range throw on read instead of silently losing precision.
  `DateTime` and `Date` map to JavaScript `Date`, and an absent optional property reads as `null`.
- **Nothing from arguments reaches the query text.** Labels, relationship types and property names
  come from the schema, unknown keys are rejected, and every value is sent as a parameter.

## Try it

Start with an empty folder, or point `cyphra pull` at an existing database to write the schema for
you:

```bash
npm i cyphra
npm i -D @cyphra/cli tsx
npx cyphra init
npx cyphra dev          # local Neo4j 5 in Docker, writes .env
npx cyphra generate     # writes cyphra.gen.ts
```

The [getting started guide](/getting-started) covers the rest, and the
[typed client reference](/client) lists every operation and filter. For an overview of using
[Neo4j with TypeScript](/) and Node.js, including the Next.js and NestJS guides, start from the home
page. If a term here was unfamiliar,
the [glossary](/glossary) defines [labels](/glossary/node-label),
[relationship types](/glossary/relationship-type) and the rest.
