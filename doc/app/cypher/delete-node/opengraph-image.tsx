import { OG_CONTENT_TYPE, OG_SIZE, docsOgImage } from "../../../components/og";

export const alt = "Delete a node with DETACH DELETE";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

export default function Image() {
  return docsOgImage("cypher/delete-node", {
    section: "cypher",
    title: "Delete a node with DETACH DELETE",
    pattern: "MATCH (u:User) DETACH DELETE u",
  });
}
