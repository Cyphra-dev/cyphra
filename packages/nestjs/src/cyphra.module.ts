import {
  Module,
  type DynamicModule,
  type FactoryProvider,
  type InjectionToken,
  type ModuleMetadata,
  type OnModuleDestroy,
  type OptionalFactoryDependency,
  type Provider,
} from "@nestjs/common";
import { CyphraHealthIndicator } from "./health.js";
import {
  DEFAULT_CONNECTION,
  getCyphraToken,
  getLifecycleToken,
  getRootClientToken,
} from "./tokens.js";
import { registerClient, transactionAware, unregisterClient } from "./transaction.js";
import type { CyphraClientLike } from "./types.js";

/** What `forRoot` and `forRootAsync` have in common. */
export interface CyphraModuleBaseOptions {
  /**
   * Name of this client, for a second database: `@InjectCyphra(connection)`,
   * `@Transactional({ connection })`. Default: `"default"`.
   */
  connection?: string;
  /** Make the client injectable in every module without importing this one. Default: `true`. */
  isGlobal?: boolean;
  /**
   * Close the client (`$disconnect()`, which closes the driver it created) when the module is
   * destroyed, on `app.close()` or a shutdown signal with `enableShutdownHooks()`. Default: `true`.
   */
  closeOnShutdown?: boolean;
}

/** Options of {@link CyphraModule.forRoot}. */
export interface CyphraModuleOptions<
  C extends CyphraClientLike = CyphraClientLike,
> extends CyphraModuleBaseOptions {
  /** The client, or a function that creates it: `() => createClient({ uri, user, password })`. */
  client: C | (() => C | Promise<C>);
}

/** Options of {@link CyphraModule.forRootAsync}. */
export interface CyphraModuleAsyncOptions<C extends CyphraClientLike = CyphraClientLike>
  extends CyphraModuleBaseOptions, Pick<ModuleMetadata, "imports"> {
  /** Creates the client, with the providers of `inject` as arguments (`ConfigService`, …). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  useFactory: (...args: any[]) => C | Promise<C>;
  /** Providers passed to `useFactory`, from `imports` or global modules. */
  inject?: Array<InjectionToken | OptionalFactoryDependency>;
  /** More providers to register in this module (for `inject`). */
  extraProviders?: Provider[];
}

/** Closes the client of one connection when the module is destroyed. */
class CyphraLifecycle implements OnModuleDestroy {
  constructor(
    private readonly connection: string,
    private readonly client: CyphraClientLike,
    private readonly close: boolean,
  ) {}

  async onModuleDestroy(): Promise<void> {
    unregisterClient(this.connection, this.client);
    if (this.close) await this.client.$disconnect();
  }
}

/**
 * Registers a Cyphra client: injectable with `@InjectCyphra()`, used by `@Transactional()` and
 * {@link CyphraHealthIndicator}, closed when the application shuts down.
 *
 * @example
 * ```ts
 * @Module({
 *   imports: [
 *     ConfigModule.forRoot(),
 *     CyphraModule.forRootAsync({
 *       imports: [ConfigModule],
 *       inject: [ConfigService],
 *       useFactory: (config: ConfigService) =>
 *         createClient({
 *           uri: config.getOrThrow("NEO4J_URI"),
 *           user: config.getOrThrow("NEO4J_USERNAME"),
 *           password: config.getOrThrow("NEO4J_PASSWORD"),
 *         }),
 *     }),
 *   ],
 * })
 * export class AppModule {}
 * ```
 */
@Module({})
export class CyphraModule {
  /** Register a client created from static options. */
  static forRoot<C extends CyphraClientLike>(options: CyphraModuleOptions<C>): DynamicModule {
    const { client } = options;
    return CyphraModule.build(options, {
      provide: getRootClientToken(options.connection),
      useFactory: typeof client === "function" ? client : () => client,
    });
  }

  /** Register a client created by a factory with injected dependencies (`ConfigService`, …). */
  static forRootAsync<C extends CyphraClientLike>(
    options: CyphraModuleAsyncOptions<C>,
  ): DynamicModule {
    return CyphraModule.build(
      options,
      {
        provide: getRootClientToken(options.connection),
        useFactory: options.useFactory,
        inject: options.inject ?? [],
      },
      options.imports,
      options.extraProviders,
    );
  }

  private static build(
    options: CyphraModuleBaseOptions,
    root: FactoryProvider,
    imports: ModuleMetadata["imports"] = [],
    extraProviders: Provider[] = [],
  ): DynamicModule {
    const connection = options.connection ?? DEFAULT_CONNECTION;
    const rootToken = getRootClientToken(connection);
    const providers: Provider[] = [
      ...extraProviders,
      root,
      {
        provide: getCyphraToken(connection),
        useFactory: (client: CyphraClientLike) => {
          registerClient(connection, client);
          return transactionAware(client, connection);
        },
        inject: [rootToken],
      },
      {
        provide: getLifecycleToken(connection),
        useFactory: (client: CyphraClientLike) =>
          new CyphraLifecycle(connection, client, options.closeOnShutdown ?? true),
        inject: [rootToken],
      },
      CyphraHealthIndicator,
    ];
    return {
      module: CyphraModule,
      global: options.isGlobal ?? true,
      imports,
      providers,
      exports: [getCyphraToken(connection), rootToken, CyphraHealthIndicator],
    };
  }
}
