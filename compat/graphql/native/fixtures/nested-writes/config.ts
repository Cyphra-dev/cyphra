import { defineGraphQL } from "@cyphra/graphql";
import type { TypeMap } from "@cyphra/runtime";

// Rules apply to requests with a `jwt` (see 07-rules): a post is updated by its author and read
// when published or by its author; a tag named "forbidden" is never created.
type Ctx = { jwt?: { sub?: string } };
const me = (ctx: Ctx) => ctx.jwt?.sub ?? "";

export default defineGraphQL<TypeMap, Ctx>({
  models: {
    User: { operations: { create: true, update: true, delete: true } },
    Profile: { operations: { create: true, update: true, delete: true } },
    Post: {
      operations: { create: true, update: true, delete: true },
      rules: {
        read: ({ ctx }) =>
          ctx.jwt ? { OR: [{ published: true }, { author: { is: { id: me(ctx) } } }] } : true,
        update: ({ ctx }) => (ctx.jwt ? { author: { is: { id: me(ctx) } } } : true),
      },
    },
    // Created (also through connectOrCreate), never updated or deleted through the API.
    Tag: {
      operations: { create: ["create"] },
      rules: { create: ({ data }) => data.name !== "forbidden" },
    },
    Comment: { operations: { update: ["update"], delete: ["delete"] } },
  },
});
