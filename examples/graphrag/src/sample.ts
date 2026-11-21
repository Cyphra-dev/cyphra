import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { markdownTitle } from "./chunk.js";
import type { DictionaryEntry } from "./entities.js";
import type { SourceDocument } from "./ingest.js";

const docsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../docs");

/** The Markdown files in `docs/`, one document each, id = file name without `.md`. */
export async function loadSampleDocuments(dir = docsDir): Promise<SourceDocument[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith(".md")).sort();
  return Promise.all(
    files.map(async (file) => {
      const markdown = await readFile(path.join(dir, file), "utf8");
      const id = file.replace(/\.md$/, "");
      return { id, title: markdownTitle(markdown) ?? id, source: `docs/${file}`, markdown };
    }),
  );
}

/** The entities the sample documents talk about, for the dictionary extractor. */
export const sampleDictionary: DictionaryEntry[] = [
  { name: "Charles Babbage", type: "person", aliases: ["Babbage"] },
  { name: "Henry Prevost Babbage", type: "person" },
  { name: "Ada Lovelace", type: "person", aliases: ["Lovelace", "A.A.L."] },
  { name: "Lord Byron", type: "person", aliases: ["Byron"] },
  { name: "Luigi Menabrea", type: "person", aliases: ["Menabrea"] },
  { name: "Joseph Marie Jacquard", type: "person" },
  { name: "Herman Hollerith", type: "person", aliases: ["Hollerith"] },
  { name: "Difference Engine", type: "machine" },
  { name: "Analytical Engine", type: "machine" },
  { name: "Jacquard loom", type: "machine" },
  { name: "Tabulating machine", type: "machine" },
  { name: "Punched card", type: "concept" },
  { name: "Note G", type: "concept" },
  { name: "Bernoulli numbers", type: "concept" },
  { name: "Census", type: "concept" },
  { name: "Tabulating Machine Company", type: "organization" },
  { name: "Computing-Tabulating-Recording Company", type: "organization" },
  { name: "IBM", type: "organization" },
  { name: "London", type: "place" },
  { name: "Lyon", type: "place" },
];
