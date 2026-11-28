# @cyphra/nestjs

> Part of [Cyphra](https://www.cyphra.dev), the TypeScript OGM (object-graph mapper) for Neo4j. **NestJS:** [guide](https://www.cyphra.dev/guides/nestjs)

The NestJS module for Cyphra: the generated typed client as an injectable provider,
`@Transactional()` service methods, a `@nestjs/terminus` health indicator, and the Neo4j driver
closed when the application shuts down. NestJS 10, 11 and 12.

```bash
npm i cyphra @cyphra/nestjs
npm i -D @cyphra/cli
```

```ts
// app.module.ts
import { CyphraModule } from "@cyphra/nestjs";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { createClient } from "./cyphra.gen.js"; // `cyphra generate`

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    CyphraModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        createClient({
          uri: config.getOrThrow("NEO4J_URI"),
          user: config.getOrThrow("NEO4J_USERNAME"),
          password: config.getOrThrow("NEO4J_PASSWORD"),
        }),
    }),
  ],
})
export class AppModule {}
```

```ts
// accounts.service.ts
import { InjectCyphra, Transactional } from "@cyphra/nestjs";
import type { Db } from "./cyphra.gen.js";

@Injectable()
export class AccountsService {
  constructor(
    @InjectCyphra() private readonly db: Db,
    private readonly ledger: LedgerService,
  ) {}

  @Transactional()
  async transfer(from: string, to: string, amount: number) {
    await this.db.account.update({
      where: { owner: from },
      data: { balance: { decrement: amount } },
    });
    await this.db.account.update({
      where: { owner: to },
      data: { balance: { increment: amount } },
    });
    await this.ledger.record(from, to, amount); // same transaction: all or nothing
  }
}
```

- `CyphraModule.forRoot({ client })` / `forRootAsync({ imports, inject, useFactory })`: global by
  default (`isGlobal: false` to scope it), `connection: "name"` for a second database,
  `closeOnShutdown: false` to close the client yourself.
- `@InjectCyphra(connection?)` injects the client (token: `getCyphraToken(connection?)`).
- `@Transactional({ connection? })` runs the method in a write transaction kept in an
  `AsyncLocalStorage`: queries made through the injected client, in this service or the ones it
  calls, use it; nested `@Transactional()` methods and `db.$transaction` join it. It commits when
  the method resolves and rolls back when it throws. The driver may retry it on transient errors.
- `getTransaction<Db>()` and `isInTransaction()` expose the active transaction.
- `CyphraHealthIndicator.isHealthy(key, { connection?, timeout? })` for
  `HealthCheckService.check([...])` (`@nestjs/terminus` 10 to 12, optional peer dependency).

Cyphra is ESM-only: use it from an ES module Nest project (the default of `nest new` in NestJS 12).
A runnable app with end-to-end tests is in
[`examples/nestjs`](https://github.com/Cyphra-dev/cyphra/tree/main/examples/nestjs).

## License

MIT
