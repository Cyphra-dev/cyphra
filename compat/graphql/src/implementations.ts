import { readFileSync } from "node:fs";
import { compat } from "@cyphra/graphql";
import { Neo4jGraphQL, Neo4jGraphQLSubscriptionsCDCEngine } from "@neo4j/graphql";
import type { GraphQLSchema } from "graphql";
import { SignJWT } from "jose";
import type { Driver } from "neo4j-driver";
import type { FixtureResolvers, Operation } from "./fixtures.js";

export type BuildOptions = {
  driver: Driver;
  /** Symmetric key used by `@authentication` / `@authorization` to verify tokens. */
  jwt: { key: string };
  /** The fixture's resolvers (`fixtures/<app>/resolvers.ts`), passed as `resolvers`. */
  resolvers?: FixtureResolvers;
};

export type SubscriptionBuildOptions = BuildOptions & {
  /** CDC polling interval in milliseconds. */
  pollTime: number;
};

/** A schema with subscriptions enabled (CDC engine), and how to stop the engine. */
export type SubscriptionSchema = { schema: GraphQLSchema; close(): void | Promise<void> };

/**
 * A GraphQL-over-Neo4j implementation under test. The reference is `@neo4j/graphql`;
 * any other implementation must produce the same SDL and the same results.
 */
export type GraphQLImplementation = {
  name: string;
  /** Returns a reason when the implementation cannot run (e.g. package not available yet). */
  skipReason?: () => Promise<string | undefined>;
  buildSchema(typeDefs: string, options: BuildOptions): Promise<GraphQLSchema>;
  /** The schema with `features.subscriptions` on a CDC engine, for `subscription` operations. */
  buildSubscriptionSchema(
    typeDefs: string,
    options: SubscriptionBuildOptions,
  ): Promise<SubscriptionSchema>;
  /** The `contextValue` passed to `execute` for one operation. */
  contextFor(op: Operation): Record<string, unknown> | Promise<Record<string, unknown>>;
};

/** Test-only signing key; not a secret. */
export const JWT_KEY = "cyphra-compat-suite-not-a-secret";

/**
 * The context of an operation, the same for every implementation: `jwt` (a decoded payload, used
 * as-is), `token` (`Bearer <jwt>` signed with HS256 by the suite key, or by `token.key` to forge one)
 * and the values of `<name>.context.json`.
 */
export async function operationContext(op: Operation): Promise<Record<string, unknown>> {
  const context: Record<string, unknown> = { ...op.context };
  if (op.jwt) context.jwt = op.jwt;
  if (op.token) {
    const jwt = await new SignJWT(op.token.payload)
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .sign(new TextEncoder().encode(op.token.key ?? JWT_KEY));
    context.token = `Bearer ${jwt}`;
  }
  return context;
}

export const neo4jGraphQL: GraphQLImplementation = {
  name: "@neo4j/graphql",
  async buildSchema(typeDefs, { driver, jwt, resolvers }) {
    const neoSchema = new Neo4jGraphQL({
      typeDefs,
      driver,
      resolvers,
      features: { authorization: { key: jwt.key } },
    });
    return neoSchema.getSchema();
  },
  async buildSubscriptionSchema(typeDefs, { driver, jwt, pollTime, resolvers }) {
    const engine = new Neo4jGraphQLSubscriptionsCDCEngine({ driver, pollTime });
    const neoSchema = new Neo4jGraphQL({
      typeDefs,
      driver,
      resolvers,
      features: { authorization: { key: jwt.key }, subscriptions: engine },
    });
    // getSchema() initializes the engine: it reads the current CDC position and starts polling.
    return { schema: await neoSchema.getSchema(), close: () => engine.close() };
  },
  // A decoded payload in `jwt` is used as-is (no token verification), which keeps
  // fixtures readable: `operations/<name>.jwt.json` holds the claims. Tokens (`<name>.token.json`)
  // are verified with the suite key.
  contextFor: operationContext,
};

/** `@cyphra/graphql` (#71-#75): the same type definitions, served on the Cyphra runtime. */
export const cyphraGraphQL: GraphQLImplementation = {
  name: "@cyphra/graphql",
  async buildSchema(typeDefs, { driver, jwt, resolvers }) {
    return compat.v7.makeSchema({
      typeDefs,
      driver,
      resolvers,
      features: { authorization: { key: jwt.key } },
    });
  },
  async buildSubscriptionSchema(typeDefs, { driver, jwt, pollTime, resolvers }) {
    const engine = new compat.v7.Neo4jGraphQLSubscriptionsCDCEngine({ driver, pollTime });
    const schema = compat.v7.makeSchema({
      typeDefs,
      driver,
      resolvers,
      features: { authorization: { key: jwt.key }, subscriptions: engine },
    });
    return { schema, close: () => engine.close() };
  },
  contextFor: operationContext,
};

/** The reference implementation; goldens are generated from it. */
export const reference = neo4jGraphQL;

export const implementations: GraphQLImplementation[] = [neo4jGraphQL, cyphraGraphQL];

/** Version of the reference implementation, pinned exactly in this workspace's package.json. */
export function referenceVersion(): string {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    devDependencies: Record<string, string>;
  };
  return pkg.devDependencies["@neo4j/graphql"]!;
}
