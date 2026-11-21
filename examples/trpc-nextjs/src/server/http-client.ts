import { createTRPCClient, httpBatchLink, type TRPCLink } from "@trpc/client";
import type { AnyTRPCRouter } from "@trpc/server";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import superjson from "superjson";
import type { AppRouter } from "./router";
import type { Context } from "./trpc";

/**
 * A tRPC client whose requests go through the same fetch handler as app/api/trpc/[trpc]/route.ts,
 * without a server: tests see what the browser sees (HTTP status, formatted errors, superjson).
 */
export function httpClient<TRouter extends AnyTRPCRouter = AppRouter>(
  router: TRouter,
  ctx: Context,
) {
  const link = httpBatchLink<AppRouter>({
    url: "http://localhost/api/trpc",
    transformer: superjson,
    fetch: (url, init) =>
      fetchRequestHandler({
        endpoint: "/api/trpc",
        req: new Request(url, init as RequestInit),
        router,
        createContext: () => ctx,
      }),
  });
  // Every router of the app shares the same config (superjson), so the link fits any of them.
  return createTRPCClient<TRouter>({ links: [link as unknown as TRPCLink<TRouter>] });
}
