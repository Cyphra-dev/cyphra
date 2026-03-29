# @cyphra/query

Cypher template tag and minimal query builder for Cyphra.

## Tagged template

```ts
import { cypher } from "@cyphra/query";

const { text, params } = cypher`
  MATCH (u:User) WHERE u.id = ${userId} RETURN u
`;
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
