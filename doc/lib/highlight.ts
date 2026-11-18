import { createHighlighter, type Highlighter } from "shiki";
import { cyphraDark, cyphraLanguage, cyphraLight } from "./shiki.mjs";

export type CodeLang = "cyphra" | "ts" | "bash" | "yaml";

let highlighter: Promise<Highlighter> | undefined;

/** Highlights code at build time (server components only) with the brand themes. */
export async function highlight(code: string, lang: CodeLang): Promise<string> {
  highlighter ??= createHighlighter({
    themes: [cyphraDark, cyphraLight],
    langs: [cyphraLanguage, "ts", "bash", "yaml"],
  });
  const h = await highlighter;
  return h.codeToHtml(code.trim(), {
    lang,
    themes: { light: "cyphra-light", dark: "cyphra-dark" },
    defaultColor: false,
  });
}
