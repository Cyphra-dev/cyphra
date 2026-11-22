/**
 * JWT verification for `@authentication` / `@authorization`, configured like `@neo4j/graphql` v7
 * (`features.authorization`): the bearer token of the request (`context.token`) is verified with
 * `jose` against a symmetric secret or a JWKS endpoint. A token that is missing, malformed, expired,
 * not yet valid or signed with another key leaves the request unauthenticated (no error), like v7.
 *
 * @packageDocumentation
 */

import {
  createRemoteJWKSet,
  decodeJwt,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyOptions,
  type RemoteJWKSetOptions,
} from "jose";

type AnyRecord = Record<string, unknown>;

/** A symmetric secret (HS256 / HS384 / HS512), or the URL of a JWKS endpoint. */
import type { CDCEngineOptions, CDCSubscriptionsEngine } from "../subscriptions/engine.js";

export type JwtKey = string | { url: string; options?: RemoteJWKSetOptions };

/** `features.authorization` of `Neo4jGraphQL`: how tokens are verified. */
export type AuthorizationFeature = {
  /** The key, or a function of the GraphQL context returning it (per request). */
  key: JwtKey | ((context: AnyRecord) => JwtKey);
  /**
   * `false` decodes tokens without verifying the signature (v7 option). Only for tokens already
   * verified upstream (e.g. by a gateway): anyone can forge an unverified token.
   */
  verify?: boolean;
  /** Passed to `jose`'s `jwtVerify` (`issuer`, `audience`, `algorithms`, `clockTolerance`, …). */
  verifyOptions?: JWTVerifyOptions;
};

/**
 * `features.subscriptions`: `true` creates a CDC engine from `driver` / `client` (polling every
 * second), an object sets its options, or pass an engine you created (and close on shutdown).
 */
export type SubscriptionsFeature =
  | boolean
  | CDCSubscriptionsEngine
  | Pick<CDCEngineOptions, "pollTime" | "pollInterval" | "onlyGraphQLEvents">;

export type Features = {
  authorization?: AuthorizationFeature;
  /** GraphQL subscriptions on Neo4j Change Data Capture (Enterprise / Aura, CDC enabled). */
  subscriptions?: SubscriptionsFeature;
};

const MAX_REMOTE_SETS = 64;

type Resolved = Uint8Array | ReturnType<typeof createRemoteJWKSet>;

/** `Bearer <token>` or a bare token (v7 accepts both). */
export function parseBearerToken(value: string): string | undefined {
  if (!value.startsWith("Bearer ")) return value || undefined;
  return value.split("Bearer ")[1] || undefined;
}

/** Verifies (or, with `verify: false`, decodes) the request token. */
export class JwtDecoder {
  private readonly staticKey?: Resolved;
  private readonly remoteSets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

  constructor(private readonly feature: AuthorizationFeature) {
    if (typeof feature.key !== "function") this.staticKey = this.resolve(feature.key);
  }

  private resolve(key: JwtKey): Resolved {
    if (typeof key === "string") return new TextEncoder().encode(key);
    if (!key || typeof key.url !== "string") {
      throw new TypeError(
        "@cyphra/graphql: features.authorization.key must be a string or { url }.",
      );
    }
    // One JWKS cache per URL, so keys are fetched once and refreshed by jose, not per request.
    // Bounded: a key function returning many URLs cannot grow it without limit.
    let set = this.remoteSets.get(key.url);
    if (!set) {
      set = createRemoteJWKSet(new URL(key.url), key.options);
      if (this.remoteSets.size >= MAX_REMOTE_SETS) {
        this.remoteSets.delete(this.remoteSets.keys().next().value!);
      }
      this.remoteSets.set(key.url, set);
    }
    return set;
  }

  /** The payload, or `undefined` when there is no token or it is not valid. */
  async decode(context: AnyRecord): Promise<JWTPayload | undefined> {
    const raw = context.token;
    if (typeof raw !== "string" || !raw) return undefined;
    const token = parseBearerToken(raw);
    if (!token) return undefined;
    try {
      if (this.feature.verify === false) return decodeJwt(token);
      const key =
        this.staticKey ?? this.resolve((this.feature.key as (c: AnyRecord) => JwtKey)(context));
      const { payload } =
        key instanceof Uint8Array
          ? await jwtVerify(token, key, this.feature.verifyOptions)
          : await jwtVerify(token, key, this.feature.verifyOptions);
      return payload;
    } catch {
      return undefined;
    }
  }
}
