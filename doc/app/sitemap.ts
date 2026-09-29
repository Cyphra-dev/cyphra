import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { MetadataRoute } from "next";

const BASE = "https://www.cyphra.dev";
const APP_DIR = join(process.cwd(), "app");

// Every docs route is an app/**/page.mdx file; walk them at build time so new
// pages land in the sitemap without editing this file.
function routes(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...routes(full));
    else if (/^page\.mdx?$/.test(name)) {
      const rel = relative(APP_DIR, dir).split("\\").join("/");
      out.push(rel ? `/${rel}` : "");
    }
  }
  return out;
}

export default function sitemap(): MetadataRoute.Sitemap {
  // No lastModified: file mtimes on Vercel are the checkout time, not edits.
  return routes(APP_DIR)
    .sort()
    .map((path) => ({ url: `${BASE}${path}`, changeFrequency: "weekly", priority: path === "" ? 1 : 0.7 }));
}
