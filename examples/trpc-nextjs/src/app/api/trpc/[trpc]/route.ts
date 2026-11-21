import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { db } from "@/server/db";
import { appRouter } from "@/server/router";

function handler(req: Request) {
  return fetchRequestHandler({
    endpoint: "/api/trpc",
    req,
    router: appRouter,
    createContext: () => ({ db: db() }),
    onError({ error, path }) {
      if (error.code === "INTERNAL_SERVER_ERROR")
        console.error(`tRPC ${path}:`, error.cause ?? error);
    },
  });
}

export { handler as GET, handler as POST };
