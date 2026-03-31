/** Collapse whitespace for stable golden comparison of Cypher text. */
export function normalizeCypher(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
