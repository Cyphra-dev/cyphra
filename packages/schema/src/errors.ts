/**
 * Thrown when a `.cyphra` document fails semantic validation after a successful parse.
 */
export class SchemaValidationError extends Error {
  override readonly name = "SchemaValidationError";

  /**
   * @param message - Human-readable explanation for library consumers.
   */
  constructor(message: string) {
    super(message);
  }
}
