/**
 * Compile-time tests of `defineGraphQL`: the config is typed against the generated client's type
 * map, so unknown models, fields and operations fail `tsc` (checked by `pnpm typecheck`).
 */
import { describe, expectTypeOf, it } from "vitest";
import { defineGraphQL } from "./config.js";
import { jwtContext, makeSchema, type JwtContext, type RequestClient } from "./index.js";

type TM = {
  User: {
    scalars: { id: string; email: string; passwordHash: string };
    createRequired: "email" | "passwordHash";
    unique: "id" | "email";
    relations: { posts: { target: "Post"; many: true; optional: false; edge: null } };
  };
  Post: {
    scalars: { id: string; title: string; published: boolean };
    createRequired: "title";
    unique: "id";
    relations: {
      author: { target: "User"; many: false; optional: true; edge: null };
      tags: { target: "Tag"; many: true; optional: false; edge: null };
    };
  };
  Tag: {
    scalars: { name: string; internal: boolean };
    createRequired: "name";
    unique: "name";
    relations: { posts: { target: "Post"; many: true; optional: false; edge: null } };
  };
};

type Ctx = { user?: { id: string; role: "MEMBER" | "ADMIN" } };

describe("defineGraphQL", () => {
  it("accepts models, fields and operations of the type map", () => {
    defineGraphQL<TM>({
      models: {
        User: {
          operations: { read: ["findMany", "count"], create: false },
          fields: { passwordHash: false, email: { filter: false, sort: false }, posts: false },
        },
        Post: { fields: { title: { deprecated: "use name" } } },
      },
      naming: { Post: { findMany: "posts" } },
      limits: { maxDepth: 4, maxTake: 100 },
    });
  });

  it("accepts write operations, write field toggles and mutationTransaction", () => {
    defineGraphQL<TM>({
      models: {
        User: {
          operations: { create: true, update: ["update"], delete: false },
          fields: { passwordHash: { read: false, create: true, update: false } },
        },
        Post: { operations: { create: ["create", "createMany"], delete: ["deleteMany"] } },
      },
      defaults: { operations: { update: true } },
      naming: { Post: { createMany: "postsCreate", upsert: "postSave" } },
      mutationTransaction: "request",
    });
  });

  it("is accepted by makeSchema, whatever the type map and context", () => {
    const api = defineGraphQL<TM, { user?: { id: string } }>({
      models: { User: { fields: { passwordHash: false } } },
    });
    void (() => makeSchema({ client: {}, config: api }));
  });

  it("rejects unknown names", () => {
    defineGraphQL<TM>({
      models: {
        // @ts-expect-error unknown model
        Usr: {},
      },
    });
    defineGraphQL<TM>({
      // @ts-expect-error unknown field
      models: { User: { fields: { pasword: false } } },
    });
    defineGraphQL<TM>({
      // @ts-expect-error unknown operation
      models: { User: { operations: { read: ["findAll"] } } },
    });
    defineGraphQL<TM>({
      // @ts-expect-error not an operation of the create group
      models: { User: { operations: { create: ["update"] } } },
    });
    defineGraphQL<TM>({
      // @ts-expect-error unknown mutationTransaction
      mutationTransaction: "operation",
    });
    defineGraphQL<TM>({
      // @ts-expect-error unknown model in naming
      naming: { Comment: { findMany: "comments" } },
    });
  });
});

describe("defineGraphQL: rules (typed against the client, #77)", () => {
  it("accepts rules, field rules and authenticated typed from the type map and the context", () => {
    defineGraphQL<TM, Ctx>({
      models: {
        User: {
          fields: {
            email: { read: { where: ({ ctx }) => ({ id: ctx.user?.id ?? "" }) } },
            passwordHash: { read: ({ ctx }) => ctx.user?.role === "ADMIN" },
          },
          rules: { update: ({ ctx }) => ({ id: ctx.user?.id ?? "" }) },
        },
        Post: {
          authenticated: { create: true, update: ["update"] },
          rules: {
            read: ({ ctx }) => ({
              OR: [{ published: true }, { author: { is: { id: ctx.user?.id ?? "" } } }],
            }),
            create: ({ ctx, data }) => ctx.user !== undefined && data.title.length > 2,
            delete: ({ ctx }) => (ctx.user?.role === "ADMIN" ? true : false),
            connect: { tags: () => ({ internal: false }) },
            disconnect: { tags: () => ({ name: { startsWith: "public-" } }) },
            after: { create: ({ ctx }) => ({ author: { is: { id: ctx.user?.id ?? "" } } }) },
          },
        },
      },
      isAuthenticated: (ctx) => ctx.user !== undefined,
    });
  });

  it("rejects rules on unknown fields, relations and values of the wrong type", () => {
    defineGraphQL<TM, Ctx>({
      models: {
        Post: {
          rules: {
            // @ts-expect-error unknown field in a read rule
            read: () => ({ publishd: true }),
          },
        },
      },
    });
    defineGraphQL<TM, Ctx>({
      models: {
        Post: {
          rules: {
            // @ts-expect-error unknown field of the related model
            update: () => ({ author: { is: { emial: "x" } } }),
          },
        },
      },
    });
    defineGraphQL<TM, Ctx>({
      models: {
        Post: {
          rules: {
            // @ts-expect-error a Boolean field compared to a string
            delete: () => ({ published: "yes" }),
          },
        },
      },
    });
    defineGraphQL<TM, Ctx>({
      models: {
        Post: {
          rules: {
            // @ts-expect-error unknown field inside OR
            read: () => ({ OR: [{ titel: "x" }] }),
          },
        },
      },
    });
    defineGraphQL<TM, Ctx>({
      models: {
        Post: {
          // @ts-expect-error unknown relation in connect
          rules: { connect: { tagz: () => true } },
        },
      },
    });
    defineGraphQL<TM, Ctx>({
      models: {
        Post: {
          rules: {
            // @ts-expect-error a connect rule is a where on the target (Tag has no title)
            connect: { tags: () => ({ title: "x" }) },
          },
        },
      },
    });
    defineGraphQL<TM, Ctx>({
      models: {
        Post: {
          rules: {
            // @ts-expect-error the create data has no "titl"
            create: ({ data }) => data.titl !== "",
          },
        },
      },
    });
    defineGraphQL<TM, Ctx>({
      models: {
        Post: {
          rules: {
            // @ts-expect-error the context has no "tenant"
            read: ({ ctx }) => ({ id: ctx.tenant }),
          },
        },
      },
    });
    defineGraphQL<TM, Ctx>({
      models: {
        Post: {
          // @ts-expect-error after takes create and update
          rules: { after: { delete: () => true } },
        },
      },
    });
    defineGraphQL<TM, Ctx>({
      models: {
        User: {
          fields: {
            // @ts-expect-error unknown field in a row-dependent field rule
            email: { read: { where: () => ({ idd: "x" }) } },
          },
        },
      },
    });
    defineGraphQL<TM, Ctx>({
      models: {
        // @ts-expect-error unknown operation in authenticated
        Post: { authenticated: { read: ["findAll"] } },
      },
    });
  });

  it("types jwtContext and the request client", () => {
    const context = jwtContext({ key: "secret", user: (jwt) => ({ id: jwt.sub ?? "" }) });
    expectTypeOf(context).returns.resolves.toEqualTypeOf<JwtContext<{ id: string }>>();
    type Db = { post: { count(): Promise<number> } };
    expectTypeOf<RequestClient<Db>["$unsafe"]>().toEqualTypeOf<Db>();
  });
});
