/** Factories of the fixture schema, shared by the test files. */
import { factoriesFor } from "../src/index.js";
import type { CyphraTypeMap } from "./fixtures/shop.gen.js";

const { defineFactory } = factoriesFor<CyphraTypeMap>();

export const users = defineFactory("TstUser", ({ sequence }) => ({
  email: `user${sequence}@example.com`,
  name: `User ${sequence}`,
}));

export const admins = users.extend({ role: "admin" });

export const tags = defineFactory("TstTag", ({ sequence }) => ({ name: `tag-${sequence}` }));

export const posts = defineFactory("TstPost", ({ sequence }) => ({
  title: `Post ${sequence}`,
  // Lazy: a post given an author does not build one.
  author: () => users.nested(),
}));
