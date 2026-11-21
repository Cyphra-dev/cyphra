import { OG_CONTENT_TYPE, OG_SIZE, docsOgImage } from "../../../components/og";

export const alt = "Migrate from Prisma and PostgreSQL to Neo4j";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

export default function Image() {
  return docsOgImage("guides/migrate-from-prisma", {
    section: "guides",
    title: "Migrate from Prisma",
    pattern: "(:ForeignKey)-[:BECOMES]->(:Edge)",
  });
}
