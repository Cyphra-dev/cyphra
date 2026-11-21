import { postRouter } from "./routers/post";
import { userRouter } from "./routers/user";
import { createCallerFactory, router } from "./trpc";

export const appRouter = router({
  user: userRouter,
  post: postRouter,
});

/** The router's type: the only thing the browser imports from the server. */
export type AppRouter = typeof appRouter;

/** Call procedures from server code and tests, without HTTP. */
export const createCaller = createCallerFactory(appRouter);
