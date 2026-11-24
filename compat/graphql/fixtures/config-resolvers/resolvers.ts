/**
 * Resolvers of the `config-resolvers` fixture: the custom `accounts` / `createAccounts` root fields
 * replace the generated ones that `@query(read: false)` / `@mutation(operations: [DELETE])` hide.
 * No resolver for `Account.settings`: `@selectable(onRead: false)` removes it, and v7 rejects
 * resolvers for fields that are not in the schema.
 */
import type { Driver } from "neo4j-driver";

type Context = { executionContext?: Driver };

export default {
  Account: {
    displayName: (account: { email: string }) => account.email.split("@")[0]!.toUpperCase(),
  },
  Query: {
    accounts: async (_root: unknown, _args: unknown, ctx: Context) => {
      const { records } = await ctx.executionContext!.executeQuery(
        "MATCH (a:Account) RETURN a { .id, .email, .role } AS a ORDER BY a.id",
      );
      return records.map((r) => r.get("a"));
    },
  },
  Mutation: {
    createAccounts: async (_root: unknown, args: { email: string }, ctx: Context) => {
      const { records } = await ctx.executionContext!.executeQuery(
        "CREATE (a:Account { id: 'new', email: $email, role: 'member' }) RETURN a { .id, .email, .role } AS a",
        { email: args.email },
      );
      return records[0]!.get("a");
    },
  },
};
