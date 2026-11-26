/**
 * Errors of the native API: GraphQL errors with a stable `extensions.code`, mapped from the
 * client's error classes.
 *
 * @packageDocumentation
 */

import { GraphQLError } from "graphql";

type AnyRecord = Record<string, unknown>;

/** A `BAD_USER_INPUT` error raised by the API itself (before any statement runs). */
export function badInput(message: string, extensions: AnyRecord = {}): GraphQLError {
  return new GraphQLError(message, { extensions: { code: "BAD_USER_INPUT", ...extensions } });
}

/** A config limit exceeded (`extensions.limit` names it). */
export function limitError(limit: string, message: string): GraphQLError {
  return badInput(message, { limit });
}

/** The client error class of `err`, by `name` (the client may come from another runtime copy). */
function errorName(err: unknown): string | undefined {
  return err instanceof Error ? err.name : undefined;
}

/**
 * The GraphQL error of an error thrown while resolving a root field. Client errors get their
 * code; anything else is `INTERNAL_SERVER_ERROR`, with the message masked unless `debug`.
 */
export function toGraphQLError(err: unknown, debug: boolean): GraphQLError {
  if (err instanceof GraphQLError) return err;
  const e = err as AnyRecord & Error;
  switch (errorName(err)) {
    case "CyphraValidationError":
      return badInput(e.message, {
        issues: ((e.issues as AnyRecord[] | undefined) ?? []).map((i) => ({
          path: i.path,
          model: i.model,
          field: i.field,
          rule: i.rule,
          message: i.message,
        })),
      });
    case "NotFoundError":
      return new GraphQLError(e.message, { extensions: { code: "NOT_FOUND" } });
    case "RestrictError":
      return new GraphQLError(e.message, {
        extensions: {
          code: "RESTRICTED",
          model: e.model,
          relation: e.relation,
          target: e.target,
          count: e.count,
        },
      });
    case "UniqueConstraintError":
      return new GraphQLError(
        `Unique constraint violated${e.model ? ` on ${String(e.model)}` : ""}${
          Array.isArray(e.fields) && e.fields.length ? ` (${e.fields.join(", ")})` : ""
        }.`,
        {
          extensions: {
            code: "UNIQUE_CONSTRAINT",
            model: e.model,
            fields: e.fields,
            constraint: e.constraint,
          },
        },
      );
    case "UnsupportedFeatureError":
      return badInput(e.message);
  }
  return new GraphQLError(debug && err instanceof Error ? err.message : "Internal server error", {
    extensions: { code: "INTERNAL_SERVER_ERROR" },
    ...(debug && err instanceof Error ? { originalError: err } : {}),
  });
}
