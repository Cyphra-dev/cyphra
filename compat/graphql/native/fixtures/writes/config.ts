import { defineGraphQL } from "@cyphra/graphql";

// Writes are off by default: turned on per model. Tag stays read-only (connect, no nested create).
export default defineGraphQL({
  models: {
    User: {
      operations: { create: true, update: true, delete: true },
      fields: {
        passwordHash: { read: false, create: true, update: false },
        role: { create: false, update: false },
      },
    },
    Post: { operations: { create: true, update: true, delete: true } },
  },
});
