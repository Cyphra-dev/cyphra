# Cyphra

**Cyphra** is a TypeScript ORM for [Neo4j](https://neo4j.com/): describe your graph in a `.cyphra` schema, generate a **fully typed client**, and keep raw **Cypher** one call away. It also ships versioned **migrations** and a **CLI**.

```cyphra
node User {
  id    String @id @default(cuid())
  email String @unique
  posts Post[] @relationship(type: "AUTHORED", direction: OUT)
}

node Post {
  id     String @id @default(uuid())
  title  String
  author User?  @relationship(type: "AUTHORED", direction: IN)
}
```

```ts
import { createClient } from "./cyphra.gen.js"; // from `cyphra generate`

const db = createClient({ uri, user, password });

const alice = await db.user.create({
  data: { email: "alice@acme.io", posts: { create: [{ title: "Hello graph" }] } },
  include: { posts: true }, // alice.posts is typed as Post[]
});

const active = await db.user.findMany({
  where: { posts: { some: { title: { contains: "graph" } } } },
  select: { email: true },
});

const rows = await db.$cypher`MATCH (u:User {email: ${email}}) RETURN u.id AS id`;
```

- **Install (app code)**: `pnpm add cyphra` — re-exports `@cyphra/schema`, `@cyphra/query`, `@cyphra/runtime`, `@cyphra/migrator`
- **CLI**: `pnpm add -D @cyphra/cli`
- **Docs site**: [`doc/`](./doc) (Next.js + Nextra) — `pnpm doc:dev` / `pnpm doc:build`
- **Example apps**: [`examples/blog/`](./examples/blog) (typed client, needs Neo4j: `pnpm example:blog`) and [`examples/basic/`](./examples/basic) (low-level APIs: `pnpm example:basic`)
- **Requires** Neo4j 5.6+ for the typed client
- **Security**: see [SECURITY.md](./SECURITY.md)

## Monorepo

```bash
pnpm install
pnpm build
pnpm test
pnpm lint
pnpm typecheck
pnpm format:check
pnpm doc:build
```

## Example

After `pnpm build` (packages need `dist/`):

```bash
pnpm example:basic
```

See [`examples/basic/README.md`](./examples/basic/README.md).

## License

MIT
