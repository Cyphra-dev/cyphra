import { z } from "zod";
import { PostCreateInputSchema, PostStatusSchema, PostUpdateInputSchema } from "../../cyphra.zod";
import { publicProcedure, router } from "../trpc";

// `omitGenerated` in cyphra.json leaves `id` and `createdAt` (generated on create) out of the
// input schemas. The procedure adds the author to connect.
const PostCreateInput = PostCreateInputSchema.extend({ authorId: z.string() });

export const postRouter = router({
  create: publicProcedure.input(PostCreateInput).mutation(({ ctx, input: { authorId, ...data } }) =>
    ctx.db.post.create({
      // connect throws NotFoundError when no User has this id: NOT_FOUND, nothing written.
      data: { ...data, author: { connect: { id: authorId } } },
      include: { author: true },
    }),
  ),

  list: publicProcedure
    .input(
      z.object({
        status: PostStatusSchema.optional(),
        authorId: z.string().optional(),
        tag: z.string().optional(),
        search: z.string().trim().max(100).optional(),
        skip: z.number().int().min(0).default(0),
        take: z.number().int().min(1).max(50).default(10),
      }),
    )
    .query(async ({ ctx, input }) => {
      const where = {
        ...(input.status ? { status: input.status } : {}),
        ...(input.authorId ? { author: { is: { id: input.authorId } } } : {}),
        ...(input.tag ? { tags: { has: input.tag } } : {}),
        ...(input.search
          ? { title: { contains: input.search, mode: "insensitive" as const } }
          : {}),
      };
      const [items, total] = await Promise.all([
        ctx.db.post.findMany({
          where,
          include: { author: { select: { id: true, name: true } } },
          orderBy: { createdAt: "desc" },
          skip: input.skip,
          take: input.take,
        }),
        ctx.db.post.count({ where }),
      ]);
      const next = input.skip + items.length;
      return { items, total, nextSkip: next < total ? next : null };
    }),

  byId: publicProcedure
    .input(z.object({ id: z.string() }))
    .query(({ ctx, input }) =>
      ctx.db.post.findUniqueOrThrow({ where: { id: input.id }, include: { author: true } }),
    ),

  update: publicProcedure
    .input(z.object({ id: z.string(), data: PostUpdateInputSchema }))
    .mutation(({ ctx, input }) =>
      ctx.db.post.update({ where: { id: input.id }, data: input.data }),
    ),

  delete: publicProcedure
    .input(z.object({ id: z.string() }))
    .mutation(({ ctx, input }) => ctx.db.post.delete({ where: { id: input.id } })),
});
