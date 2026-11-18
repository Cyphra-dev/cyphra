/** Base class for errors raised by the Cyphra ORM client. */
export class CyphraError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Invalid arguments: unknown field, wrong value type, missing unique key, … */
export class CyphraValidationError extends CyphraError {}

/** A node required by the operation does not exist (`update`, `delete`, `connect`, `…OrThrow`). */
export class NotFoundError extends CyphraError {}
