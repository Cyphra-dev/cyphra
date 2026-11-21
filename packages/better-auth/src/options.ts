import type { BetterAuthOptions } from "better-auth/types";
import { getAuthTables } from "better-auth/db";
import { initGetFieldName, initGetModelName } from "better-auth/adapters";
import { deriveAuthGraph, type AuthGraph, type NumberFields } from "./schema.js";

/** Options that must match the ones passed to `cyphraAdapter`. */
export interface AuthSchemaOptions {
  usePlural?: boolean;
  /** Same as `cyphraAdapter({ numberFields })`. */
  numberFields?: NumberFields;
}

/**
 * The Cyphra schema for a Better Auth configuration: the same one the adapter derives at
 * runtime. `document` is the `.cyphra` AST (print it with `printSchemaDocument`), `schema` the
 * resolved model (use it with `createOrm` or the migrator).
 *
 * @example
 * ```ts
 * import { constraintStatementsFromSchema } from "@cyphra/migrator";
 * const { document } = authSchema(auth.options);
 * constraintStatementsFromSchema(document); // CREATE CONSTRAINT … for User, Session, …
 * ```
 */
export function authSchema(options: BetterAuthOptions, naming: AuthSchemaOptions = {}): AuthGraph {
  const tables = getAuthTables(options);
  const usePlural = naming.usePlural ?? false;
  return deriveAuthGraph(
    {
      schema: tables,
      getModelName: initGetModelName({ schema: tables, usePlural }),
      getFieldName: initGetFieldName({ schema: tables, usePlural }),
    },
    { numberFields: naming.numberFields },
  );
}
