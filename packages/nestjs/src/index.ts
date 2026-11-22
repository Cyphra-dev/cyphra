/**
 * NestJS integration of Cyphra: `CyphraModule.forRoot` / `forRootAsync`, `@InjectCyphra()`,
 * `@Transactional()` and a `@nestjs/terminus` health indicator.
 *
 * @packageDocumentation
 */

export {
  CyphraModule,
  type CyphraModuleAsyncOptions,
  type CyphraModuleBaseOptions,
  type CyphraModuleOptions,
} from "./cyphra.module.js";
export {
  CyphraHealthCheckError,
  CyphraHealthIndicator,
  type CyphraHealthCheckOptions,
  type CyphraHealthIndicatorResult,
} from "./health.js";
export { InjectCyphra } from "./inject.js";
export { DEFAULT_CONNECTION, getCyphraToken } from "./tokens.js";
export {
  Transactional,
  getTransaction,
  isInTransaction,
  type TransactionalOptions,
} from "./transaction.js";
export type { CyphraClientLike, CyphraTransaction } from "./types.js";
