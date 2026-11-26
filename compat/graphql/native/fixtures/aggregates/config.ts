import { defineGraphQL } from "@cyphra/graphql";
import type { TypeMap } from "@cyphra/runtime";

type Ctx = { jwt?: { sub?: string; role?: string } };
const isAdmin = (ctx: Ctx) => ctx.jwt?.role === "ADMIN";

export default defineGraphQL<TypeMap, Ctx>({
  models: {
    User: {
      // Context-only: admins read salaries; others cannot aggregate, group or sort on them.
      fields: { salary: { read: ({ ctx }) => isAdmin(ctx) } },
    },
    // Secret posts do not exist for non-admins: not counted, summed or grouped.
    Post: { rules: { read: ({ ctx }) => (isAdmin(ctx) ? true : { secret: false }) } },
  },
  limits: { maxTake: 50 },
});
