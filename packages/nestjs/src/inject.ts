import { Inject } from "@nestjs/common";
import { getCyphraToken } from "./tokens.js";

/**
 * Inject the Cyphra client of a connection. Type the parameter with your generated client:
 * `@InjectCyphra() private readonly db: Db`. Inside a `@Transactional()` method, its queries run
 * in that transaction.
 *
 * @param connection - `connection` of `CyphraModule.forRoot`, for a second database.
 */
export function InjectCyphra(connection?: string): PropertyDecorator & ParameterDecorator {
  return Inject(getCyphraToken(connection));
}
