import { defineGraphQL } from "@cyphra/graphql";

// mutationTransaction: "request": every root field of a mutation operation in one transaction.
export default defineGraphQL({
  models: {
    User: {
      operations: { create: true, update: true, delete: true },
      fields: { passwordHash: { read: false, create: true, update: false } },
    },
    Post: { operations: { create: true, update: true, delete: true } },
  },
  mutationTransaction: "request",
});
