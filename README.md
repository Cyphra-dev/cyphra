# Cyphra

**Cyphra** is a TypeScript **OGM** (object-graph mapper) for [Neo4j](https://neo4j.com/) and compatible graph databases ([Memgraph](https://www.cyphra.dev/memgraph), [FalkorDB](https://www.cyphra.dev/falkordb)), what other stacks call an ORM ([why OGM?](https://www.cyphra.dev/neo4j-orm#orm-or-ogm)): describe your graph in a `.cyphra` schema, generate a **fully typed client**, and keep raw **Cypher** one call away. It also ships versioned **migrations** and a **CLI**.

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

```bash
cyphra dev                          # local Neo4j 5 in Docker, writes .env
cyphra migrate dev --name add-roles # migration generated from your schema changes, then applied
cyphra pull                         # or start from an existing database: write schema.cyphra
```

- **Install (app code)**: `pnpm add cyphra` — re-exports `@cyphra/schema`, `@cyphra/query`, `@cyphra/runtime`, `@cyphra/migrator`
- **CLI**: `pnpm add -D @cyphra/cli`
- **NestJS**: `pnpm add @cyphra/nestjs` — module, injected client, `@Transactional()`, health check ([guide](https://cyphra.dev/guides/nestjs), [`examples/nestjs/`](./examples/nestjs))
- **Testing**: `pnpm add -D @cyphra/testing testcontainers` — database in Docker, migrations, isolation, typed factories ([docs](https://cyphra.dev/testing))
- **Docs site**: [`doc/`](./doc) (Next.js + Nextra) — `pnpm doc:dev` / `pnpm doc:build`
- **Example apps**: [`examples/blog/`](./examples/blog) (typed client, needs Neo4j: `pnpm example:blog`) and [`examples/basic/`](./examples/basic) (low-level APIs: `pnpm example:basic`)
- **Requires** Neo4j 5.6+ for the typed client, Memgraph 3.x with `dialect: "memgraph"` ([feature matrix](https://cyphra.dev/memgraph)), or FalkorDB 4.x with the `falkordb` option ([feature matrix](https://cyphra.dev/falkordb))
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
