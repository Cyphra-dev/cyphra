import { OG_CONTENT_TYPE, OG_SIZE, docsOgImage } from "../../components/og";

export const alt = "Cyphra Privacy Policy";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

export default function Image() {
  return docsOgImage("privacy", {
    section: "legal",
    title: "Privacy Policy",
    pattern: "(:PersonalData)-[:PROTECTED_BY]->(:GDPR)",
  });
}
