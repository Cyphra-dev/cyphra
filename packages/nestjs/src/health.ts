import { Inject, Injectable } from "@nestjs/common";
import { ModuleRef } from "@nestjs/core";
import { DEFAULT_CONNECTION, getRootClientToken } from "./tokens.js";
import type { CyphraClientLike } from "./types.js";

/** Status of one indicator, in the shape `@nestjs/terminus` expects (`HealthIndicatorResult`). */
export type CyphraHealthIndicatorResult<K extends string = string> = Record<
  K,
  { status: "up" | "down"; [detail: string]: unknown }
>;

/** Options of {@link CyphraHealthIndicator.isHealthy}. */
export interface CyphraHealthCheckOptions {
  /** Connection to check (`connection` of `CyphraModule.forRoot`). */
  connection?: string;
  /** Milliseconds to wait for the database before reporting it down. Default: 5000. */
  timeout?: number;
}

/**
 * Raised by {@link CyphraHealthIndicator.isHealthy} when the database is down and the installed
 * `@nestjs/terminus` is v10, which only reads failures from rejected indicators
 * (`isHealthCheckError`, with the result in `causes`). Terminus 11 and later read the
 * `status: "down"` result instead.
 */
export class CyphraHealthCheckError extends Error {
  readonly isHealthCheckError = true;
  constructor(
    message: string,
    readonly causes: CyphraHealthIndicatorResult,
  ) {
    super(message);
    this.name = "CyphraHealthCheckError";
  }
}

let legacyTerminus: Promise<boolean> | undefined;

/** Whether the installed `@nestjs/terminus` is v10 (no `HealthIndicatorService`, added in v11). */
function isLegacyTerminus(): Promise<boolean> {
  legacyTerminus ??= import("@nestjs/terminus").then(
    (terminus) => !("HealthIndicatorService" in terminus),
    () => false,
  );
  return legacyTerminus;
}

/**
 * Health indicator for `@nestjs/terminus` (v10 to v12): runs `RETURN 1` on the database.
 *
 * @example
 * ```ts
 * @Controller("health")
 * export class HealthController {
 *   constructor(
 *     private readonly health: HealthCheckService,
 *     private readonly cyphra: CyphraHealthIndicator,
 *   ) {}
 *
 *   @Get()
 *   @HealthCheck()
 *   check() {
 *     return this.health.check([() => this.cyphra.isHealthy("neo4j")]);
 *   }
 * }
 * ```
 */
@Injectable()
export class CyphraHealthIndicator {
  constructor(@Inject(ModuleRef) private readonly moduleRef: ModuleRef) {}

  /**
   * `{ [key]: { status: "up" } }` when the database answers within `timeout`, otherwise
   * `{ [key]: { status: "down", message } }` (thrown as a {@link CyphraHealthCheckError} with
   * Terminus 10). `HealthCheckService.check` turns a down database into a 503.
   */
  async isHealthy<K extends string = "cyphra">(
    key: K = "cyphra" as K,
    options: CyphraHealthCheckOptions = {},
  ): Promise<CyphraHealthIndicatorResult<K>> {
    const { connection = DEFAULT_CONNECTION, timeout = 5000 } = options;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const client = this.moduleRef.get<CyphraClientLike>(getRootClientToken(connection), {
        strict: false,
      });
      await Promise.race([
        client.$cypher`RETURN 1 AS ok`,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`timeout of ${timeout}ms exceeded`)), timeout);
        }),
      ]);
      return { [key]: { status: "up" } } as CyphraHealthIndicatorResult<K>;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const result = {
        [key]: { status: "down", message },
      } as unknown as CyphraHealthIndicatorResult<K>;
      if (await isLegacyTerminus()) {
        throw new CyphraHealthCheckError(`${key} is not available: ${message}`, result);
      }
      return result;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
