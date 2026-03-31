/**
 * Typed error for query DSL / compiler validation failures.
 * Messages stay human-readable; `code` is stable for programmatic handling.
 */
export class CyphraQueryError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CyphraQueryError";
  }
}
