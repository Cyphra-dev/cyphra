# Cyphra example — blog

The typed ORM workflow end to end:

1. `schema.cyphra` declares nodes, relations and a typed edge (`Follows`).
2. `cyphra generate` writes `src/cyphra.gen.ts`: model types and a typed `createClient()`.
3. `src/main.ts` uses `db.user.create(...)`, nested `create` / `connect`, `include`, relation filters and `updateMany`.

## Run

```bash
# from the repository root, once
pnpm install && pnpm -r --filter './packages/*' run build

# start a local Neo4j 5
docker run -d --name neo4j -p 7687:7687 -e NEO4J_AUTH=neo4j/password neo4j:5

NEO4J_URI=bolt://localhost:7687 NEO4J_USERNAME=neo4j NEO4J_PASSWORD=password pnpm --filter cyphra-example-blog start
```
