import { defineGraphQL } from "@cyphra/graphql";

export default defineGraphQL({
  models: {
    User: { fields: { passwordHash: false, email: { filter: false, sort: false } } },
    Post: { fields: { title: { deprecated: "use a headline" } } },
    AuditLog: { operations: { read: ["findMany", "count"] } },
    Comment: { operations: { read: false } },
  },
  naming: { Post: { findMany: "posts", findUnique: "post" } },
  limits: { maxDepth: 2, maxTake: 3, maxAliases: 3, maxComplexity: 20 },
});
