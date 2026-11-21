import { createClient } from "./cyphra.gen.js";
import { embedderFromEnv } from "./embeddings.js";
import { dictionaryExtractor, llmExtractor } from "./entities.js";
import { ingest } from "./ingest.js";
import { chatFromEnv } from "./llm.js";
import { buildPrompt, retrieve } from "./retrieve.js";
import { loadSampleDocuments, sampleDictionary } from "./sample.js";
import { applySchema } from "./setup.js";

const { NEO4J_URI, NEO4J_USERNAME, NEO4J_PASSWORD } = process.env;
if (!NEO4J_URI || !NEO4J_USERNAME || !NEO4J_PASSWORD) {
  console.log("Set NEO4J_URI, NEO4J_USERNAME and NEO4J_PASSWORD to run this example.");
  process.exit(0);
}

const questions = process.argv.slice(2);
if (questions.length === 0) {
  questions.push(
    "Who wrote the first computer program?",
    "Where did the idea of punched cards come from?",
  );
}

const db = createClient({ uri: NEO4J_URI, user: NEO4J_USERNAME, password: NEO4J_PASSWORD });
const embedder = embedderFromEnv();
const chat = chatFromEnv();
// LLM_EXTRACT=1 extracts entities with the model (one call per chunk) instead of the dictionary.
const extractor =
  chat && process.env.LLM_EXTRACT === "1"
    ? llmExtractor(chat)
    : dictionaryExtractor(sampleDictionary);

try {
  await applySchema(db);
  const stats = await ingest(db, await loadSampleDocuments(), { embedder, extractor });
  console.log(
    `Ingested ${stats.documents} documents, ${stats.chunks} chunks, ${stats.entities} entities.`,
  );

  for (const question of questions) {
    const retrieval = await retrieve(db, question, { embedder, extractor });
    console.log(`\n=== ${question}\n`);
    for (const c of retrieval.chunks) {
      const why = c.via === "match" ? c.matchedBy.join("+") : c.via;
      const extra = c.via === "entity" ? ` via ${c.entities.join(", ")}` : "";
      console.log(`  ${c.id.padEnd(22)} ${why}${extra}`);
    }
    console.log(`\n${retrieval.context}`);
    if (chat) console.log(`\n--- Answer ---\n${await chat(buildPrompt(retrieval))}`);
  }
} finally {
  await db.$disconnect();
}
