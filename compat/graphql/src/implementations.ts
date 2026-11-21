import { readFileSync } from "node:fs";
import { compat } from "@cyphra/graphql";
import { Neo4jGraphQL } from "@neo4j/graphql";
import type { GraphQLSchema } from "graphql";
import type { Driver } from "neo4j-driver";
import type { Operation } from "./fixtures.js";

export type BuildOptions = {
  driver: Driver;
  /** Symmetric key used by `@authentication` / `@authorization` to verify tokens. */
  jwt: { key: string };
};

/**
 * A GraphQL-over-Neo4j implementation under test. The reference is `@neo4j/graphql`;
 * any other implementation must produce the same SDL and the same results.
 */
export type GraphQLImplementation = {
  name: string;
  /** Returns a reason when the implementation cannot run (e.g. package not available yet). */
  skipReason?: () => Promise<string | undefined>;
  buildSchema(typeDefs: string, options: BuildOptions): Promise<GraphQLSchema>;
  /** The `contextValue` passed to `execute` for one operation. */
  contextFor(op: Operation): Record<string, unknown>;
};

/** Test-only signing key; not a secret. */
export const JWT_KEY = "cyphra-compat-suite-not-a-secret";

export const neo4jGraphQL: GraphQLImplementation = {
  name: "@neo4j/graphql",
  async buildSchema(typeDefs, { driver, jwt }) {
    const neoSchema = new Neo4jGraphQL({
      typeDefs,
      driver,
      features: { authorization: { key: jwt.key } },
    });
    return neoSchema.getSchema();
  },
  // A decoded payload in `jwt` is used as-is (no token verification), which keeps
  // fixtures readable: `operations/<name>.jwt.json` holds the claims.
  contextFor: (op) => (op.jwt ? { jwt: op.jwt } : {}),
};

/** `@cyphra/graphql` (#71-#75): the same type definitions, served on the Cyphra runtime. */
export const cyphraGraphQL: GraphQLImplementation = {
  name: "@cyphra/graphql",
  async buildSchema(typeDefs, { driver }) {
    return compat.v7.makeSchema({ typeDefs, driver });
  },
  contextFor: (op) => compat.v7.contextFor({ jwt: op.jwt }),
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
