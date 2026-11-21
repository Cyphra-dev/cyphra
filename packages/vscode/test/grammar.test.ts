import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { SCALAR_TYPE_NAMES } from "@cyphra/schema";
import oniguruma from "vscode-oniguruma";
import textmate from "vscode-textmate";
import { describe, expect, it } from "vitest";
import { buildGrammar, SCOPE_NAME } from "../src/grammar.js";

const require = createRequire(import.meta.url);

async function loadGrammar(types: readonly string[]) {
  const wasm = readFileSync(require.resolve("vscode-oniguruma/release/onig.wasm"));
  await oniguruma.loadWASM(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength));
  const registry = new textmate.Registry({
    onigLib: Promise.resolve({
      createOnigScanner: (patterns: string[]) => new oniguruma.OnigScanner(patterns),
      createOnigString: (s: string) => new oniguruma.OnigString(s),
    }),
    loadGrammar: async (scope: string) =>
      scope === SCOPE_NAME
        ? textmate.parseRawGrammar(JSON.stringify(buildGrammar(types)), "cyphra.tmLanguage.json")
        : null,
  });
  const grammar = await registry.loadGrammar(SCOPE_NAME);
  if (!grammar) throw new Error("grammar not loaded");
  return grammar;
}

/** One line per token: the text and its scopes (without the root scope). */
async function tokenize(source: string, types: readonly string[] = SCALAR_TYPE_NAMES) {
  const grammar = await loadGrammar(types);
  let state = textmate.INITIAL;
  const out: string[] = [];
  for (const line of source.split("\n")) {
    const r = grammar.tokenizeLine(line, state);
    for (const t of r.tokens) {
      const text = line.slice(t.startIndex, t.endIndex);
      if (!text.trim()) continue;
      const scopes = t.scopes.filter((s) => s !== SCOPE_NAME);
      out.push(`${JSON.stringify(text)} ${scopes.join(" ") || "-"}`);
    }
    state = r.ruleStack;
  }
  return out;
}

describe("TextMate grammar", () => {
  it("highlights the sample schema (snapshot)", async () => {
    const source = readFileSync(new URL("./fixtures/sample.cyphra", import.meta.url), "utf8");
    const tokens = await tokenize(source);
    await expect(`${tokens.join("\n")}\n`).toMatchFileSnapshot(
      "./__snapshots__/sample.cyphra.tokens",
    );
  });

  it("highlights every scalar type of @cyphra/schema, including new ones", async () => {
    for (const t of SCALAR_TYPE_NAMES) {
      expect(await tokenize(`node A {\n  x ${t}?\n}`)).toContain(
        `${JSON.stringify(t)} support.type.primitive.cyphra`,
      );
    }
    // A type added to the list lights up without touching the grammar source.
    expect(
      await tokenize("node A {\n  at LocalTime\n}", [...SCALAR_TYPE_NAMES, "LocalTime"]),
    ).toContain('"LocalTime" support.type.primitive.cyphra');
  });

  it("highlights interfaces and implements lists", async () => {
    const tokens = await tokenize(
      "interface P {\n  x Int\n}\nnode A implements P, Q {\n  y Int\n}",
    );
    expect(tokens).toContain('"interface" keyword.declaration.interface.cyphra');
    expect(tokens).toContain('"P" entity.name.type.interface.cyphra');
    expect(tokens).toContain('"implements" keyword.other.implements.cyphra');
    expect(tokens).toContain('"Q" entity.name.type.interface.cyphra');
    expect(tokens).toContain('"x" variable.other.property.cyphra');
    expect(tokens).toContain('"y" variable.other.property.cyphra');
  });

  it("does not end a block on a brace inside a string or a comment", async () => {
    const tokens = await tokenize('node A {\n  x String @default("}") // }\n  y Int\n}');
    expect(tokens).toContain('"y" variable.other.property.cyphra');
  });
});
