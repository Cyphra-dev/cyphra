import { defineGraphQL } from "@cyphra/graphql";
import type { TypeMap } from "@cyphra/runtime";

type Ctx = { jwt?: { sub?: string; role?: string } };
const isAdmin = (ctx: Ctx) => ctx.jwt?.role === "ADMIN";

export default defineGraphQL<TypeMap, Ctx>({
  models: {
    Person: {
      operations: { traverse: true },
      // Hidden people do not exist for non-admins: no path goes through them.
      rules: { read: ({ ctx }) => (isAdmin(ctx) ? true : { hidden: false }) },
      // Each person reads their own email only, also on the nodes of a path.
      fields: { email: { read: { where: ({ ctx }) => ({ id: ctx.jwt?.sub ?? "" }) } } },
    },
    Chunk: { rules: { read: ({ ctx }) => (isAdmin(ctx) ? true : { hidden: false }) } },
  },
  // Chunk.context: the chunks that mention what this chunk mentions, or an entity related to it.
  traversals: {
    Chunk: {
      context: {
        via: [
          { rel: "entities" },
          { rel: "related", direction: "both", depth: { min: 0, max: 1 } },
          { rel: "chunks" },
        ],
        args: ["where", "orderBy", "take"],
        description: "Chunks about the same entities, or entities related to them.",
      },
    },
  },
  limits: { maxTraversalDepth: 3 },
});
