import type { ValidationRuleName } from "@cyphra/schema";

/** Base class for errors raised by the Cyphra ORM client. */
export class CyphraError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
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

/**
 * The operation (or one of its options) is not available on the configured database dialect, e.g.
 * a `Time` field on Memgraph, which has no zoned time type. Thrown before any statement runs, in
 * place of Cypher the database would reject or answer differently.
 *
 * @example
 * ```ts
 * try {
 *   await db.user.search({ index: "userSearch", query: "graph", mode: "lucene" });
 * } catch (e) {
 *   if (e instanceof UnsupportedFeatureError) console.warn(e.feature, e.dialect);
 * }
 * ```
 */
export class UnsupportedFeatureError extends CyphraError {
  constructor(
    /** What is unsupported, phrased to read "<feature> is not supported on …", e.g. `"User.opensAt (a Time field)"`. */
    readonly feature: string,
    /** The dialect it is unavailable on. */
    readonly dialect: "neo4j" | "memgraph" | "falkordb",
    /** What to do instead (appended to the message). */
    hint?: string,
  ) {
    super(
      `${feature} is not supported on ${dialect === "memgraph" ? "Memgraph" : dialect === "falkordb" ? "FalkorDB" : "Neo4j"}${hint ? `: ${hint}` : "."}`,
    );
  }
}

/** A node required by the operation does not exist (`update`, `delete`, `connect`, `…OrThrow`). */
export class NotFoundError extends CyphraError {}

/**
 * A rule of the client (see `withEngineRules`, used by `@cyphra/graphql`'s native API) refused the
 * operation: a `create` rule, an `after` rule, or a to-one edge a write had to replace whose target
 * the `disconnect` rule hides. Nothing was written (the transaction was rolled back).
 */
export class ForbiddenError extends CyphraError {
  constructor(
    /** Model whose rule refused the operation. */
    readonly model: string,
    /** The rule: `create`, `after.create`, `after.update` or `disconnect`. */
    readonly operation: "create" | "after.create" | "after.update" | "disconnect",
    /** For `disconnect`: the relation field. */
    readonly relation?: string,
  ) {
    super(
      operation === "create"
        ? `Forbidden: the rules do not allow creating this ${model}.`
        : operation === "disconnect"
          ? `Forbidden: the rules do not allow disconnecting the current ${model}.${relation ?? ""} node, which this write replaces.`
          : `Forbidden: the ${model} written does not satisfy the ${operation} rule.`,
    );
  }
}

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

/**
 * A write broke a uniqueness constraint: a duplicate `@id` / `@unique` value, a duplicate
 * `@@unique([a, b])` combination, or a duplicate relationship `@unique` property. Thrown by every
 * write (`create`, `createMany`, `update`, `updateMany`, `upsert`, nested `create` /
 * `connectOrCreate`, `$edge` data, `$cypher`) on both transports, in place of Neo4j's
 * `Neo.ClientError.Schema.ConstraintValidationFailed`. The transaction was rolled back.
 *
 * @example
 * ```ts
 * try {
 *   await db.user.create({ data: { email } });
 * } catch (e) {
 *   if (e instanceof UniqueConstraintError && e.fields.includes("email")) {
 *     return { error: "This email is already registered." };
 *   }
 *   throw e;
 * }
 * ```
 */
export class UniqueConstraintError extends CyphraError {
  /**
   * Model that declares the constraint: the node model of the label (an interface for a field or
   * `@@unique` declared on it) or the relationship model of the type. `undefined` when the label
   * is not in the schema or Neo4j's message could not be read.
   */
  readonly model: string | undefined;
  /** Constrained fields (in the constraint's order when the schema has it), `[]` when unknown. */
  readonly fields: readonly string[];
  /**
   * Name of the constraint, as `cyphra push` / migrations create it (`User_email_unique`, a
   * `@@unique` name, …), when the schema declares it.
   */
  readonly constraint: string | undefined;
  /** Neo4j status code (`Neo.ClientError.Schema.ConstraintValidationFailed`). */
  readonly code: string;
  /** GQL status code reported by the server (driver 6 / newer servers), if any. */
  readonly gqlStatus: string | undefined;
  /** The original Neo4j error (`Neo4jError` or `Neo4jHttpError`). */
  declare readonly cause: unknown;

  constructor(
    message: string,
    info: {
      model?: string;
      fields?: readonly string[];
      constraint?: string;
      code: string;
      gqlStatus?: string;
    },
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.model = info.model;
    this.fields = info.fields ?? [];
    this.constraint = info.constraint;
    this.code = info.code;
    this.gqlStatus = info.gqlStatus;
  }
}
