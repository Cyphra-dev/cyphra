import type { MetadataRoute } from "next";
import { SITEMAP_DOC_SEGMENTS } from "../lib/sitemap-paths";

const site = "https://www.cyphra.dev";

export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();
  return SITEMAP_DOC_SEGMENTS.map((seg) => ({
    url: seg === "" ? site : `${site}/${seg}`,
    lastModified: now,
    changeFrequency: "weekly" as const,
    priority: seg === "" ? 1 : 0.8,
  }));
}
