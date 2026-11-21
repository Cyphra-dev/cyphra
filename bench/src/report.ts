/** `pnpm --filter cyphra-bench report`: regenerate results/RESULTS.md from results/latest.json. */
import { readFileSync, writeFileSync } from "node:fs";
import { markdown, type Results } from "./results.js";

const dir = new URL("../results/", import.meta.url);
const results = JSON.parse(readFileSync(new URL("latest.json", dir), "utf8")) as Results;
writeFileSync(new URL("RESULTS.md", dir), markdown(results));
console.log("Wrote results/RESULTS.md");
