/** Name of the connection registered when `connection` is left out. */
export const DEFAULT_CONNECTION = "default";

/**
 * Injection token of the client of a connection: what {@link InjectCyphra} injects. Useful with
 * `moduleRef.get(getCyphraToken())` or in a `useFactory` provider's `inject` list.
 */
export function getCyphraToken(connection: string = DEFAULT_CONNECTION): string {
  return connection === DEFAULT_CONNECTION ? "CyphraClient" : `CyphraClient:${connection}`;
}

/** Token of the client as created by the factory (no transaction routing). Internal. */
export function getRootClientToken(connection: string = DEFAULT_CONNECTION): string {
  return `CyphraRootClient:${connection}`;
}

/** Token of the provider that closes the client when the module is destroyed. Internal. */
export function getLifecycleToken(connection: string = DEFAULT_CONNECTION): string {
  return `CyphraLifecycle:${connection}`;
}
