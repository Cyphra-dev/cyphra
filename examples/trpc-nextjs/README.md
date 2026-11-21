# Cyphra example: tRPC with Next.js

A typed API on Neo4j with Next.js (App Router), tRPC 11 and TanStack Query. The guide that walks
through it is at [cyphra.dev/guides/trpc](https://cyphra.dev/guides/trpc).

- `schema.cyphra`: `User` and `Post`, linked by `(User)-[:WROTE]->(Post)`, with an enum status,
  validation rules (`@email`, `@length`, `@size`) and `onDelete: Cascade` on `User.posts`.
- `cyphra.json`: `cyphra generate` writes the client (`src/server/cyphra.gen.ts`) and the zod
  schemas (`src/cyphra.zod.ts`). Both are generated, so they are not committed.
- `src/server/trpc.ts`: tRPC setup with superjson, and the error mapping: zod and
  `CyphraValidationError` give `BAD_REQUEST` with `issues`, `NotFoundError` gives `NOT_FOUND`,
  `RestrictError` and uniqueness violations give `CONFLICT`.
- `src/server/routers/`: `post.create`, `post.list` (filters and pagination), `post.byId`,
  `post.update`, `post.delete`, `user.create`, `user.list`, `user.delete`. Inputs are the generated
  zod schemas.
- `src/app/api/trpc/[trpc]/route.ts`: the fetch adapter. `src/trpc/client.tsx` and
  `src/app/page.tsx`: the React client.

## Run

```bash
# from the repository root, once
pnpm install && pnpm -r --filter './packages/*' run build && pnpm install --offline

# a local Neo4j 5
docker run -d --name neo4j -p 7687:7687 -e NEO4J_AUTH=neo4j/password neo4j:5

cd examples/trpc-nextjs
printf 'NEO4J_URI=bolt://localhost:7687\nNEO4J_USERNAME=neo4j\nNEO4J_PASSWORD=password\n' > .env
pnpm push   # constraints: unique User.id, User.email and Post.id
pnpm dev    # http://localhost:3000
```

## Test

```bash
pnpm --filter cyphra-example-trpc-nextjs test   # error mapping over HTTP; the Neo4j tests are skipped
NEO4J_TEST_URI=bolt://localhost:7687 NEO4J_TEST_USER=neo4j NEO4J_TEST_PASSWORD=password \
  pnpm --filter cyphra-example-trpc-nextjs test # also every procedure against Neo4j
```

The Neo4j tests call the router with `createCaller` and delete every `User` and `Post` node of the
database they run on.
