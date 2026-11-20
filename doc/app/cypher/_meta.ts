import type { MetaRecord } from "nextra";

const meta: MetaRecord = {
  index: "Overview",
  "--write": { type: "separator", title: "Writing" },
  "upsert-merge": "Upsert with MERGE",
  "merge-vs-create": "MERGE vs CREATE",
  "create-relationship": "Create a relationship",
  "delete-node": "Delete a node",
  "--read": { type: "separator", title: "Reading" },
  pagination: "Pagination",
  "count-relationships": "Count relationships",
  "--schema": { type: "separator", title: "Schema and safety" },
  "unique-constraint": "Unique constraints",
  parameters: "Parameters and injection",
  "--guides": { type: "separator", title: "Guides" },
  "framework-guides": { title: "Framework guides", href: "/guides" },
};

export default meta;
