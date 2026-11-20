import { OG_CONTENT_TYPE, OG_SIZE, docsOgImage } from "../../../components/og";

export const alt = "Upsert with MERGE";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

export default function Image() {
  return docsOgImage("cypher/upsert-merge", {
    section: "cypher",
    title: "Upsert with MERGE",
    pattern: "MERGE (u:User {email: $email})",
  });
}
