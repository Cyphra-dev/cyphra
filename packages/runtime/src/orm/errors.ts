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

/**
 * A delete was refused by an `onDelete: Restrict` rule: nodes are still linked through
 * `model.relation`. Nothing was deleted.
 */
export class RestrictError extends CyphraError {
  constructor(
    /** Model of the node whose deletion was refused (the root or a node reached by a cascade). */
    readonly model: string,
    /** Relation field with `onDelete: Restrict`. */
    readonly relation: string,
    /** Model of the linked nodes. */
    readonly target: string,
    /** How many linked nodes (not themselves deleted by this operation) block the delete. */
    readonly count: number,
  ) {
    super(
      `Cannot delete ${model}: ${count} ${target} node${count === 1 ? " is" : "s are"} still linked through ${model}.${relation} (onDelete: Restrict).`,
    );
  }
}
