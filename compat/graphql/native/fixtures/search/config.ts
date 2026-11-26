import { defineGraphQL } from "@cyphra/graphql";
import type { TypeMap } from "@cyphra/runtime";

type Ctx = { jwt?: { role?: string } };
const isAdmin = (ctx: Ctx) => ctx.jwt?.role === "ADMIN";

export default defineGraphQL<TypeMap, Ctx>({
  models: {
    // Unpublished articles do not exist for non-admins: no search, findSimilar or union hit.
    Article: {
      operations: { traverse: ["findSimilar"] },
      rules: { read: ({ ctx }) => (isAdmin(ctx) ? true : { published: true }) },
    },
    SearchHit: { operations: { traverse: true } },
  },
  limits: { maxTake: 10 },
});
