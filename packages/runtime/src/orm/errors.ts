import type { ValidationRuleName } from "@cyphra/schema";

/** Base class for errors raised by the Cyphra ORM client. */
export class CyphraError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/**
 * One value of a write that breaks a validation rule of the schema (`@length`, `@min`, …).
 */
export type ValidationIssue = {
  /**
   * Where the value is in the operation's arguments, e.g. `["data", "posts", "create", 0, "title"]`
   * for `create({ data: { posts: { create: [{ title }] } } })`.
   */
  readonly path: readonly (string | number)[];
  /** Model (node or relationship model) of the field. */
  readonly model: string;
  /** Field name (the last string of `path`). */
  readonly field: string;
  /** The rule broken: its decorator name without `@` (`length`, `min`, `email`, …). */
  readonly rule: ValidationRuleName;
  /** What the value must be, e.g. `must be at least 3 characters long (got 1).` */
  readonly message: string;
};

/**
 * Invalid arguments: unknown field, wrong value type, missing unique key, … When values break
 * the schema's validation rules, `issues` lists every one of them (and no statement was run).
 */
export class CyphraValidationError extends CyphraError {
  /** Every value that breaks a validation rule (empty for other invalid arguments). */
  readonly issues: readonly ValidationIssue[];

  constructor(message: string, issues: readonly ValidationIssue[] = []) {
    super(message);
    this.issues = issues;
  }
}

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
