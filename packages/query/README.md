# @cyphra/query

**Parameterized Cypher** for Cyphra: a **`cypher`** tagged template and a small **`SelectQuery`** builder. Values are always sent as **query parameters**, not string concatenation.

## Install

```bash
npm install @cyphra/query
```

## Tagged template

```ts
import { cypher } from "@cyphra/query";

const compiled = cypher`
  MATCH (u:User) WHERE u.id = ${userId} RETURN u
`;
// compiled.text, compiled.params → session.run(...)
```

## Builder

```ts
import { node, rel, prop, eq, select } from "@cyphra/query";

const u = node("User", "u");
const o = node("Organization", "o");
const m = rel("MEMBER_OF", "m");

const q = select()
  .match(u.out(m, o))
  .where(eq(prop(m.alias, "role"), "admin"))
  .returnFields({ userId: prop(u.alias, "id"), orgName: prop(o.alias, "name") });

q.toCypher();
```

The package also exports write/batch helpers (`compileCreate`, `compileMergeSet`, `unionAllCompiled`, …).

## Documentation

**[cyphra.dev — Queries](https://www.cyphra.dev/queries)**

## License

MIT
