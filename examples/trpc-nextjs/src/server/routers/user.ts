import { z } from "zod";
import { UserCreateInputSchema } from "../../cyphra.zod";
import { publicProcedure, router } from "../trpc";

export const userRouter = router({
  create: publicProcedure
    .input(UserCreateInputSchema)
    .mutation(({ ctx, input }) => ctx.db.user.create({ data: input })),

  list: publicProcedure.query(({ ctx }) =>
    ctx.db.user.findMany({ orderBy: { name: "asc" }, take: 100 }),
  ),

  // `onDelete: Cascade` on User.posts: the user's posts are deleted in the same transaction.
  delete: publicProcedure
    .input(z.object({ id: z.string() }))
    .mutation(({ ctx, input }) => ctx.db.user.delete({ where: { id: input.id } })),
});
