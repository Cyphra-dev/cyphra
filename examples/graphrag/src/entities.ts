import type { Complete } from "./llm.js";

export interface ExtractedEntity {
  name: string;
  /** Free-form category: `person`, `machine`, `organization`, `concept`, `place`… */
  type: string;
}

/** An undirected link between two extracted entities, by name. */
export interface ExtractedRelation {
  from: string;
  to: string;
}

export interface Extraction {
  entities: ExtractedEntity[];
  relations: ExtractedRelation[];
}

/** Finds the entities a text mentions, and how they relate. Swap it for an LLM, spaCy, an API… */
export interface EntityExtractor {
  extract(text: string): Promise<Extraction>;
}

/** Stable node id for an entity name: `"Ada Lovelace"` → `"ada-lovelace"`. */
export function entityId(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export interface DictionaryEntry {
  name: string;
  type: string;
  /** Other spellings that refer to the same entity (`"Babbage"` for `"Charles Babbage"`). */
  aliases?: string[];
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Rule-based extraction from a dictionary (a gazetteer): every name or alias found in the text, as
 * a whole word, case-insensitive, plural `s` allowed. Longer names win over the shorter names they
 * contain ("Jacquard loom" over "Jacquard"). Entities found in the same text are related to each
 * other (co-occurrence), which is how many GraphRAG pipelines build their entity graph.
 *
 * Deterministic, free and fast; it only finds what the dictionary lists.
 */
export function dictionaryExtractor(entries: readonly DictionaryEntry[]): EntityExtractor {
  const patterns = entries
    .flatMap((entry) => [entry.name, ...(entry.aliases ?? [])].map((term) => ({ term, entry })))
    .sort((a, b) => b.term.length - a.term.length)
    .map(({ term, entry }) => ({
      entry,
      re: new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(term)}(?:e?s)?(?![\\p{L}\\p{N}])`, "giu"),
    }));

  return {
    async extract(text) {
      const taken: [number, number][] = [];
      const found = new Map<string, ExtractedEntity>();
      for (const { entry, re } of patterns) {
        for (const m of text.matchAll(re)) {
          const start = m.index;
          const end = start + m[0].length;
          if (taken.some(([s, e]) => start < e && end > s)) continue;
          taken.push([start, end]);
          found.set(entry.name, { name: entry.name, type: entry.type });
        }
      }
      const entities = [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
      const relations: ExtractedRelation[] = [];
      for (let i = 0; i < entities.length; i++) {
        for (let j = i + 1; j < entities.length; j++) {
          relations.push({ from: entities[i]!.name, to: entities[j]!.name });
        }
      }
      return { entities, relations };
    },
  };
}

/**
 * Extraction with a language model. The model is asked for JSON; relations that name an entity it
 * did not list are dropped. Costs one model call per chunk, so it is not used by default.
 */
export function llmExtractor(complete: Complete): EntityExtractor {
  return {
    async extract(text) {
      const reply = await complete(
        [
          "Extract the named entities (people, organizations, places, products, key concepts) from the",
          "text below, and the pairs of entities the text relates to each other.",
          'Answer with JSON only: {"entities":[{"name":"…","type":"person|organization|place|product|concept"}],',
          '"relations":[{"from":"<entity name>","to":"<entity name>"}]}',
          "",
          "Text:",
          text,
        ].join("\n"),
      );
      const json = reply.slice(reply.indexOf("{"), reply.lastIndexOf("}") + 1);
      const parsed = JSON.parse(json) as Partial<Extraction>;
      const entities = (parsed.entities ?? []).filter(
        (e): e is ExtractedEntity => typeof e?.name === "string" && typeof e.type === "string",
      );
      const names = new Set(entities.map((e) => e.name));
      const relations = (parsed.relations ?? []).filter(
        (r) => names.has(r?.from) && names.has(r?.to) && r.from !== r.to,
      );
      return { entities, relations };
    },
  };
}
