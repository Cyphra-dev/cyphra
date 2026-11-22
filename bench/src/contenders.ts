/**
 * The libraries under test, each set up on the same Neo4j database. Every Bolt contender but neogma
 * shares one `neo4j-driver` Driver (neogma always builds its own, from the same version and the
 * same default config).
 */
import { compat } from "@cyphra/graphql";
import { Neo4jGraphQL } from "@neo4j/graphql";
import { execute, parse, validate, type DocumentNode, type GraphQLSchema } from "graphql";
import type { Driver } from "neo4j-driver";
// neogma is CommonJS: Node 22 does not detect all of its named exports (`Type` is a re-export),
// so read them from the default export.
import neogmaModule, { type Related } from "neogma";
import type { Config } from "./config.js";
import { createClient, type Db } from "./cyphra.gen.js";

const { Neogma, Node, NodeEntity, PrimaryKey, Property, Relationship, Type } = neogmaModule;

export type ContenderId =
  | "neo4j-driver"
  | "cyphra"
  | "neogma"
  | "query-api"
  | "cyphra-http"
  | "neo4j-graphql"
  | "cyphra-graphql";

export const CONTENDERS: Record<ContenderId, { label: string; note: string }> = {
  "neo4j-driver": { label: "neo4j-driver (raw Cypher)", note: "baseline, Bolt" },
  cyphra: { label: "Cyphra", note: "typed client, Bolt" },
  neogma: { label: "neogma", note: "OGM, Bolt" },
  "query-api": { label: "Query API (raw fetch)", note: "baseline, HTTP" },
  "cyphra-http": { label: "Cyphra (HTTP)", note: "typed client, HTTP transport" },
  "neo4j-graphql": { label: "@neo4j/graphql", note: "GraphQL, Bolt" },
  "cyphra-graphql": { label: "@cyphra/graphql", note: "GraphQL, Bolt" },
};

export function cyphraBolt(driver: Driver, cfg: Config): Db {
  return createClient({ driver, database: cfg.neo4j.database });
}

export function cyphraHttp(cfg: Config): Db {
  return createClient({
    uri: cfg.neo4j.httpUri,
    user: cfg.neo4j.user,
    password: cfg.neo4j.password,
    database: cfg.neo4j.database,
  });
}

// --- neogma: the same labels and relationship types as schema.cyphra --------------------------

@Node({ label: "Comment" })
class CommentNode extends NodeEntity {
  @PrimaryKey(Type.String()) id!: string;
  @Property(Type.String()) text!: string;
}

@Node({ label: "Post" })
class PostNode extends NodeEntity {
  @PrimaryKey(Type.String()) id!: string;
  @Property(Type.String()) title!: string;
  @Property(Type.Number()) views!: number;
  @Property(Type.Boolean()) published!: boolean;
  @Relationship({ name: "HAS_COMMENT", direction: "out", model: () => CommentNode })
  comments!: Related<typeof CommentNode>;
}

@Node({ label: "User" })
class UserNode extends NodeEntity {
  @PrimaryKey(Type.String()) id!: string;
  @Property(Type.String()) email!: string;
  @Property(Type.String()) name!: string;
  @Property(Type.Number()) age!: number;
  @Relationship({ name: "AUTHORED", direction: "out", model: () => PostNode })
  posts!: Related<typeof PostNode>;
}

export function neogmaModels(cfg: Config) {
  const neogma = new Neogma({
    url: cfg.neo4j.boltUri,
    username: cfg.neo4j.user,
    password: cfg.neo4j.password,
    database: cfg.neo4j.database,
  });
  const Comments = neogma.model(CommentNode);
  const Posts = neogma.model(PostNode);
  const Users = neogma.model(UserNode);
  return { neogma, Users, Posts, Comments };
}

export type NeogmaModels = ReturnType<typeof neogmaModels>;

// --- GraphQL: the same type definitions for both libraries -----------------------------------

export const TYPE_DEFS = /* GraphQL */ `
  type User @node {
    id: ID! @id
    email: String!
    name: String!
    age: Int!
    createdAt: DateTime! @timestamp(operations: [CREATE])
    posts: [Post!]! @relationship(type: "AUTHORED", direction: OUT)
    following: [User!]! @relationship(type: "FOLLOWS", direction: OUT)
    followers: [User!]! @relationship(type: "FOLLOWS", direction: IN)
  }

  type Post @node {
    id: ID! @id
    title: String!
    views: Int!
    published: Boolean! @default(value: false)
    author: [User!]! @relationship(type: "AUTHORED", direction: IN)
    comments: [Comment!]! @relationship(type: "HAS_COMMENT", direction: OUT)
  }

  type Comment @node {
    id: ID! @id
    text: String!
    post: [Post!]! @relationship(type: "HAS_COMMENT", direction: IN)
  }
`;

/** Executes a GraphQL operation; the document is parsed and validated once, then cached. */
export type GqlExec = (source: string, variables?: Record<string, unknown>) => Promise<unknown>;

function executor(schema: GraphQLSchema, context: () => Record<string, unknown>): GqlExec {
  const docs = new Map<string, DocumentNode>();
  return async (source, variables) => {
    let document = docs.get(source);
    if (!document) {
      document = parse(source);
      const errors = validate(schema, document);
      if (errors.length) throw new Error(`GraphQL validation: ${errors[0]!.message}`);
      docs.set(source, document);
    }
    const res = await execute({
      schema,
      document,
      variableValues: variables,
      contextValue: context(),
    });
    if (res.errors?.length) throw new Error(`GraphQL: ${res.errors[0]!.message}`);
    return res.data;
  };
}

export async function neo4jGraphQL(driver: Driver, cfg: Config): Promise<GqlExec> {
  const schema = await new Neo4jGraphQL({ typeDefs: TYPE_DEFS, driver }).getSchema();
  return executor(schema, () => ({ sessionConfig: { database: cfg.neo4j.database } }));
}

export function cyphraGraphQL(driver: Driver, cfg: Config): GqlExec {
  const schema = compat.v7.makeSchema({
    typeDefs: TYPE_DEFS,
    driver: driver as never,
    database: cfg.neo4j.database,
  });
  return executor(schema, () => ({}));
}
