import { GraphQLError } from "graphql";

/** Issues tracking the parts of the v7 API that are generated but not served yet. */
export const FOLLOW_UP = {
  cypher: 75,
} as const;

/** The operation is part of the v7 API but `@cyphra/graphql` does not execute it yet. */
export function notImplemented(what: string, issue: number): GraphQLError {
  return new GraphQLError(`Not implemented yet in @cyphra/graphql (see #${issue}): ${what}`, {
    extensions: { code: "NOT_IMPLEMENTED" },
  });
}
