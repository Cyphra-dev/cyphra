/**
 * `native.jwtContext`: a GraphQL context function verifying the request's bearer token, with the
 * same `jose` verifier as `compat.v7`'s `features.authorization`, so both APIs can share one
 * context function.
 *
 * @packageDocumentation
 */

import type { JWTPayload } from "jose";
import { JwtDecoder, type AuthorizationFeature } from "../v7/auth/jwt.js";

type AnyRecord = Record<string, unknown>;

/** Options of {@link jwtContext}: how tokens are verified, and the `user` built from one. */
export type JwtContextOptions<User = never> = AuthorizationFeature & {
  /**
   * The context's `user`, from the verified payload (absent without a valid token), e.g.
   * `(jwt) => ({ id: jwt.sub, role: jwt.role })`. Without it, the context has no `user`.
   */
  readonly user?: (jwt: JWTPayload) => User;
};

/**
 * The context {@link jwtContext} builds: `token` is the `Authorization` header as received,
 * `jwt` the verified payload (absent when the token is missing, malformed, expired or signed with
 * another key: the request is then anonymous, no error), `user` what `options.user` made of it.
 */
export type JwtContext<User = never> = {
  token?: string;
  jwt?: JWTPayload;
  user?: User;
};

/** The `Authorization` header of a Fetch `Request` (`{ request }`) or a Node request (`{ req }`). */
function authorizationOf(init: unknown): string | undefined {
  if (typeof init !== "object" || init === null) return undefined;
  const { request, req } = init as { request?: unknown; req?: unknown };
  for (const r of [request, req]) {
    const headers = (r as { headers?: unknown } | undefined)?.headers;
    if (!headers) continue;
    if (typeof (headers as { get?: unknown }).get === "function") {
      const v = (headers as { get(name: string): string | null }).get("authorization");
      if (v) return v;
      continue;
    }
    const v = (headers as AnyRecord).authorization ?? (headers as AnyRecord).Authorization;
    if (typeof v === "string" && v) return v;
    if (Array.isArray(v) && typeof v[0] === "string") return v[0];
  }
  return undefined;
}

/**
 * A GraphQL context function verifying the request's `Authorization: Bearer <jwt>` header (from
 * `{ request }`, GraphQL Yoga and other Fetch servers, or `{ req }`, Apollo Server on Node) with
 * `key`: a symmetric secret or a JWKS `{ url }` (or a function returning one). Its context also
 * works for `compat.v7` (`jwt` is trusted there, `token` kept), so one context function can serve
 * both APIs. Rules see it as `ctx`; the default `isAuthenticated` is "has a `user` or a `jwt`".
 *
 * @example
 * ```ts
 * const context = native.jwtContext({
 *   key: process.env.JWT_SECRET!,
 *   verifyOptions: { issuer: "https://auth.example.com" },
 *   user: (jwt) => ({ id: jwt.sub!, role: jwt.role as "MEMBER" | "ADMIN" }),
 * });
 * createYoga({ schema, context: native.context(schema, context) });
 * ```
 *
 * @experimental
 */
export function jwtContext<User = never>(
  options: JwtContextOptions<User>,
): (init?: unknown) => Promise<JwtContext<User>> {
  const decoder = new JwtDecoder(options);
  return async (init) => {
    const token = authorizationOf(init);
    if (!token) return {};
    const jwt = await decoder.decode({ token });
    if (!jwt) return { token };
    return options.user ? { token, jwt, user: options.user(jwt) } : { token, jwt };
  };
}
