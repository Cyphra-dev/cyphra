import { defineGraphQL, native } from "@cyphra/graphql";
import type { TypeMap } from "@cyphra/runtime";

type Ctx = { jwt?: { sub?: string; role?: string } };
const isAdmin = (ctx: Ctx) => ctx.jwt?.role === "ADMIN";
const { cypher } = native;

/** The client the API runs on: the computed fields it exposes come from `$extends`. */
export const client = (db: object) =>
  (db as { $extends(e: unknown): object }).$extends({
    result: {
      person: {
        fullName: {
          needs: { firstName: true, lastName: true },
          compute: (p: { firstName: string; lastName: string }) => `${p.firstName} ${p.lastName}`,
        },
      },
    },
  });

export default defineGraphQL<TypeMap, Ctx>({
  models: {
    Person: { fields: { email: { read: ({ ctx }) => isAdmin(ctx) } } },
    Post: {
      operations: { update: ["update"] },
      // Drafts are visible to their author only (and admins).
      rules: {
        read: ({ ctx }) =>
          isAdmin(ctx)
            ? true
            : { OR: [{ published: true }, { author: { is: { id: ctx.jwt?.sub ?? "" } } }] },
        update: ({ ctx }) => ({ author: { is: { id: ctx.jwt?.sub ?? "" } } }),
      },
    },
  },
  computed: { Person: { fullName: "String!" } },
  cypherFields: {
    Person: {
      followerCount: {
        type: "Int!",
        description: "How many people follow this person.",
        cypher: ({ node }) => cypher`COUNT { (${node})<-[:FOLLOWS]-() }`,
      },
      followersSince: {
        type: "Int!",
        args: { since: "DateTime!" },
        cypher: ({ node, args }) =>
          cypher`COUNT { (${node})<-[f:FOLLOWS]-() WHERE f.since >= ${args.since} }`,
      },
      isMe: {
        type: "Boolean!",
        // The context is a parameter: a hostile `sub` cannot change the statement.
        cypher: ({ node, ctx }) => cypher`${node}.id = ${ctx.jwt?.sub ?? null}`,
      },
      writings: {
        type: "[Post!]!",
        args: { first: { type: "Int", default: 10 } },
        // Raw Cypher returns every post (the LIMIT applies before any rule); the read rule of Post
        // filters what is returned.
        cypher: ({ node, args }) =>
          cypher`COLLECT { MATCH (${node})-[:WROTE]->(p) RETURN p ORDER BY p.id LIMIT ${args.first} }`,
      },
    },
  },
  extend: {
    typeDefs: /* GraphQL */ `
      "Numbers for a dashboard: a type that is not a node."
      type Stats {
        people: Int!
        posts: Int!
        topAuthors: [Person!]!
      }
      extend type Query {
        stats: Stats!
        me: Person
        searchPosts(text: String!): [Post!]!
      }
      extend type Mutation {
        publishPost(id: ID!): Post
      }
      extend type Person {
        greeting: String!
      }
    `,
    resolvers: {
      Query: {
        stats: () => ({}),
        me: (_, __, ctx, info) =>
          ctx.jwt?.sub
            ? ctx.cyphra.person.findUnique({
                where: { id: ctx.jwt.sub },
                ...ctx.cyphra.selection(info),
              })
            : null,
        searchPosts: (_, args: { text: string }, ctx, info) =>
          ctx.cyphra.post.findMany({
            where: { title: { contains: args.text } },
            orderBy: [{ id: "asc" }],
            ...ctx.cyphra.selection(info),
          }),
      },
      Stats: {
        people: (_, __, ctx) => ctx.cyphra.person.count(),
        posts: (_, __, ctx) => ctx.cyphra.post.count(),
        topAuthors: (_, __, ctx, info) =>
          ctx.cyphra.person.findMany({
            orderBy: [{ posts: { _count: "desc" } }, { id: "asc" }],
            take: 2,
            ...ctx.cyphra.selection(info),
          }),
      },
      Mutation: {
        publishPost: (_, args: { id: string }, ctx, info) =>
          ctx.cyphra.post.update({
            where: { id: args.id },
            data: { published: true },
            ...ctx.cyphra.selection(info),
          }),
      },
      Person: {
        greeting: {
          needs: { firstName: true },
          resolve: (person: { firstName: string }) => `Hello, ${person.firstName}!`,
        },
      },
    },
  },
});
