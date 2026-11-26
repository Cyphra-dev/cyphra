import { defineGraphQL } from "@cyphra/graphql";
import type { TypeMap } from "@cyphra/runtime";

// The context is what native.jwtContext builds (or a decoded `jwt`): rules read `ctx.jwt`.
type Ctx = { jwt?: { sub?: string; role?: string } };
const me = (ctx: Ctx) => ctx.jwt?.sub ?? "";
const isAdmin = (ctx: Ctx) => ctx.jwt?.role === "ADMIN";

export default defineGraphQL<TypeMap, Ctx>({
  models: {
    User: {
      operations: { update: ["update"] },
      fields: {
        passwordHash: false,
        // Row-dependent: each user reads their own email; others are null, also to filters.
        email: { read: { where: ({ ctx }) => ({ id: me(ctx) }) } },
        // Context-only: admins read salaries; others get FORBIDDEN where they use one.
        salary: { read: ({ ctx }) => isAdmin(ctx) },
      },
      rules: { update: ({ ctx }) => ({ id: me(ctx) }) },
    },
    Post: {
      operations: { create: true, update: true, delete: true },
      authenticated: { create: true, update: true, delete: true },
      rules: {
        read: ({ ctx }) => ({ OR: [{ published: true }, { author: { is: { id: me(ctx) } } }] }),
        update: ({ ctx }) => ({ author: { is: { id: me(ctx) } } }),
        delete: ({ ctx }) => (isAdmin(ctx) ? true : { author: { is: { id: me(ctx) } } }),
        after: { create: ({ ctx }) => ({ author: { is: { id: me(ctx) } } }) },
        connect: { tags: () => ({ internal: false }) },
        disconnect: { tags: () => ({ internal: false }) },
      },
    },
    Tag: {
      operations: { create: ["create"] },
      rules: { create: ({ ctx }) => isAdmin(ctx) },
    },
    // Never readable through the API, wherever it is reached (v7's @query(read: false) is not).
    Audit: { rules: { read: () => false } },
  },
});
