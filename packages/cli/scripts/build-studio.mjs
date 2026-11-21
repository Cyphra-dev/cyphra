// Build the studio UI (src/studio/ui) into dist/studio: app.js, theme.js, app.css, index.html and
// the icon. Run after tsup (which empties dist/). Everything is bundled: no CDN at runtime.
import { copyFile, mkdir, readdir, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const src = path.join(root, "src/studio/ui");
const out = path.join(root, "dist/studio");
await mkdir(out, { recursive: true });

await build({
  entryPoints: {
    app: path.join(src, "main.ts"),
    theme: path.join(src, "theme.ts"),
  },
  outdir: out,
  bundle: true,
  minify: true,
  format: "iife",
  target: ["es2022"],
  platform: "browser",
  legalComments: "none",
  logLevel: "warning",
});
await build({
  entryPoints: { app: path.join(src, "styles.css") },
  outdir: out,
  bundle: true,
  minify: true,
  logLevel: "warning",
});
await copyFile(path.join(src, "index.html"), path.join(out, "index.html"));
await copyFile(path.join(src, "icon.svg"), path.join(out, "icon.svg"));

let total = 0;
for (const f of await readdir(out)) total += (await stat(path.join(out, f))).size;
process.stdout.write(`studio UI: dist/studio (${(total / 1024).toFixed(1)} KB)\n`);
