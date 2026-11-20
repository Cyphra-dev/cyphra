import type { MetaRecord } from "nextra";

const meta: MetaRecord = {
  index: "Overview",
  "--frameworks": { type: "separator", title: "Frameworks" },
  nextjs: "Next.js",
  nestjs: "NestJS",
  bun: "Bun",
  "--deploy": { type: "separator", title: "Deploy" },
  vercel: "Vercel",
  "--cypher": { type: "separator", title: "Cypher" },
  "cypher-howtos": { title: "Cypher how-tos", href: "/cypher" },
};

export default meta;
