import { defineGraphQL } from "@cyphra/graphql";
import type { TypeMap } from "@cyphra/runtime";

// The context is what native.jwtContext builds (or a decoded `jwt`): rules read `ctx.jwt`.
type Ctx = { jwt?: { sub?: string; role?: string } };
const me = (ctx: Ctx) => ctx.jwt?.sub ?? "";
const isAdmin = (ctx: Ctx) => ctx.jwt?.role === "ADMIN";

export default defineGraphQL<TypeMap, Ctx>({
  // Subscriptions are off by default: on for every model here.
  defaults: { operations: { subscribe: true } },
  models: {
    // No rules: a subscriber reads every user, so it gets every DELETED event.
    User: {},
    Post: {
      fields: {
        // Context-only: only admins read views (and see it in changedFields).
        views: { read: ({ ctx }) => isAdmin(ctx) },
      },
      rules: {
        // Published posts, and the subscriber's own drafts: also what events are re-read with.
        read: ({ ctx }) => ({ OR: [{ published: true }, { author: { is: { id: me(ctx) } } }] }),
      },
    },
    // Internal tags are hidden: no event names one, also as the other end of a relationship.
    Tag: {
      authenticated: { subscribe: true },
      rules: { read: () => ({ internal: false }) },
    },
    // Never readable: subscribing is FORBIDDEN.
    Audit: { rules: { read: () => false } },
  },
});
