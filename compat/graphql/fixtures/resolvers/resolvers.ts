/**
 * Resolvers of the `resolvers` fixture, passed as `resolvers` to every implementation (like
 * `new Neo4jGraphQL({ typeDefs, resolvers })`). Deterministic, so goldens are stable.
 */
import type { Driver } from "neo4j-driver";

type Context = { jwt?: { sub?: string; roles?: string[] }; executionContext?: Driver };

/** Fixed per viewer and lab, so results are stable. */
function percent(sub: string | undefined, labId: string): number {
  if (!sub) return 0;
  return ((sub.length * 10 + Number(labId.slice(1)) * 7) % 100) + 1;
}

export default {
  Lab: {
    myProgress: (lab: { id: string }, _args: unknown, ctx: Context) => ({
      labId: lab.id,
      percent: percent(ctx.jwt?.sub, lab.id),
      viewer: ctx.jwt?.sub ?? null,
    }),
    titleUpper: (lab: { title: string }) => lab.title.toUpperCase(),
    authorNames: (lab: { authors: { name: string }[] }) => lab.authors.map((a) => a.name).sort(),
  },
  FeedItem: {
    __resolveType: (item: { sub?: string }) => ("sub" in item ? "Viewer" : "ProgressSummary"),
  },
  Query: {
    // Reads the database through the driver v7 puts in `context.executionContext`.
    stats: async (_root: unknown, args: { level?: string }, ctx: Context) => {
      const { records } = await ctx.executionContext!.executeQuery(
        "MATCH (l:Lab) WHERE $level IS NULL OR l.level = $level RETURN count(l) AS n",
        { level: args.level ?? null },
      );
      return {
        labCount: records[0]!.get("n"),
        level: args.level ?? null,
        featured: { id: "l2", title: "Cypher deep dive", level: "ADVANCED" },
      };
    },
    whoAmI: (_root: unknown, _args: unknown, ctx: Context) =>
      ctx.jwt ? { sub: ctx.jwt.sub ?? null, roles: ctx.jwt.roles ?? [] } : null,
    adminNote: () => "for authenticated users",
    feed: () => [
      { labId: "l1", percent: 10, viewer: null },
      { sub: "user-ann", roles: ["student"] },
    ],
  },
  Mutation: {
    recordProgress: (
      _root: unknown,
      { input }: { input: { labId: string; percent: number; note?: string } },
      ctx: Context,
    ) => ({ ...input, note: input.note ?? null, by: ctx.jwt?.sub ?? null }),
  },
};
