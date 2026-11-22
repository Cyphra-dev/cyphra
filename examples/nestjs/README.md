# Cyphra example: NestJS

A small REST API on Neo4j with NestJS 12 and [`@cyphra/nestjs`](../../packages/nestjs). The guide
that walks through it is at [cyphra.dev/guides/nestjs](https://cyphra.dev/guides/nestjs).

- `schema.cyphra`: `Account` and `Transfer`, linked by `SENT` and `RECEIVED` relationships.
- `src/app.module.ts`: `CyphraModule.forRootAsync` creates the generated client from
  `ConfigService` (`.env`); `TerminusModule` for the health check.
- `src/accounts/accounts.service.ts`: `transfer` is `@Transactional()`: the debit, the credit and
  the ledger entry written by `LedgerService` commit together, or not at all when the balance would
  go negative.
- `src/health.controller.ts`: `GET /health` with `CyphraHealthIndicator`.
- `src/main.ts`: `enableShutdownHooks()`, so `SIGTERM` closes the app and the Neo4j driver.
- `test/app.e2e.test.ts`: the HTTP API against a real Neo4j. `vitest.config.ts` compiles with `tsc`
  so Nest gets the constructor parameter types (`emitDecoratorMetadata`), which esbuild does not
  emit.

## Run

```bash
# from the repository root, once
pnpm install && pnpm -r --filter './packages/*' run build && pnpm install --offline

# a local Neo4j 5
docker run -d --name neo4j -p 7687:7687 -e NEO4J_AUTH=neo4j/password neo4j:5

cd examples/nestjs
cp .env.example .env
pnpm push    # constraints: unique Account.owner, ids
pnpm build && pnpm start
```

```bash
curl -X POST localhost:3000/accounts -H 'content-type: application/json' -d '{"owner":"alice","balance":100}'
curl -X POST localhost:3000/accounts -H 'content-type: application/json' -d '{"owner":"bob"}'
curl -X POST localhost:3000/accounts/transfers -H 'content-type: application/json' \
  -d '{"from":"alice","to":"bob","amount":30}'
curl localhost:3000/accounts/alice   # balance 70 and the transfer
curl -X POST localhost:3000/accounts/transfers -H 'content-type: application/json' \
  -d '{"from":"alice","to":"bob","amount":500}'   # 400, nothing written
curl localhost:3000/health
```

## Test

```bash
NEO4J_TEST_URI=bolt://localhost:7687 NEO4J_TEST_USER=neo4j NEO4J_TEST_PASSWORD=password \
  pnpm --filter cyphra-example-nestjs test
```

Without the variables the tests are skipped. They delete every `Account` and `Transfer` node of
the database they run on.
