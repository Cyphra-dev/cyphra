/**
 * Compile-time tests of `defineGraphQL`: the config is typed against the generated client's type
 * map, so unknown models, fields and operations fail `tsc` (checked by `pnpm typecheck`).
 */
import { describe, it } from "vitest";
import { defineGraphQL } from "./config.js";
import { makeSchema } from "./index.js";

type TM = {
  User: {
    scalars: { id: string; email: string; passwordHash: string };
    createRequired: "email" | "passwordHash";
    unique: "id" | "email";
    relations: { posts: { target: "Post"; many: true; optional: false; edge: null } };
  };
  Post: {
    scalars: { id: string; title: string };
    createRequired: "title";
    unique: "id";
    relations: { author: { target: "User"; many: false; optional: true; edge: null } };
  };
};

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
      // @ts-expect-error writes are not served yet
      models: { User: { operations: { create: true } } },
    });
    defineGraphQL<TM>({
      // @ts-expect-error unknown model in naming
      naming: { Comment: { findMany: "comments" } },
    });
  });
});
