// Syntax highlighting shared by the MDX pipeline (next.config.mjs) and the landing page.
// - `cyphraLanguage`: a small TextMate grammar for `.cyphra` schema files.
// - `cyphraDark` / `cyphraLight`: the brand code themes (mint for decorators and strings,
//   violet for keywords), tuned for at least 4.5:1 contrast on the code background.

/** @type {import("shiki").LanguageRegistration} */
export const cyphraLanguage = {
  name: "cyphra",
  scopeName: "source.cyphra",
  aliases: ["cy"],
  patterns: [
    { include: "#comment" },
    {
      match: "\\b(node|relationship|enum)\\s+([A-Za-z_]\\w*)",
      captures: {
        1: { name: "keyword.declaration.cyphra" },
        2: { name: "entity.name.type.cyphra" },
      },
    },
    {
      match: '^\\s*(type|from|to)\\b(?=\\s+["A-Z])',
      captures: { 1: { name: "keyword.other.cyphra" } },
    },
    { include: "#decorator" },
    { include: "#string" },
    {
      match: "^\\s*([a-z_]\\w*)(?=\\s)",
      captures: { 1: { name: "variable.other.property.cyphra" } },
    },
    { include: "#value" },
  ],
  repository: {
    comment: {
      patterns: [
        { name: "comment.line.double-slash.cyphra", match: "//.*$" },
        { name: "comment.block.cyphra", begin: "/\\*", end: "\\*/" },
      ],
    },
    decorator: {
      patterns: [
        { name: "entity.name.function.decorator.cyphra", match: "@@?[A-Za-z_]\\w*" },
        {
          match: "\\b([a-z_]\\w*)\\s*(:)",
          captures: {
            1: { name: "variable.parameter.cyphra" },
            2: { name: "punctuation.separator.cyphra" },
          },
        },
      ],
    },
    string: { name: "string.quoted.double.cyphra", begin: '"', end: '"' },
    value: {
      patterns: [
        { name: "constant.numeric.cyphra", match: "\\b\\d+(\\.\\d+)?\\b" },
        { name: "constant.language.cyphra", match: "\\b(true|false|null|IN|OUT|BOTH)\\b" },
        {
          name: "support.type.primitive.cyphra",
          match: "\\b(String|Int|Float|Boolean|DateTime|Date)\\b",
        },
        { name: "entity.name.type.cyphra", match: "\\b[A-Z]\\w*\\b" },
        { name: "support.function.cyphra", match: "\\b[a-z_]\\w*(?=\\()" },
        { name: "keyword.operator.cyphra", match: "[?]|\\[\\]" },
        { name: "punctuation.cyphra", match: "[{}()\\[\\],:]" },
      ],
    },
  },
};

/**
 * @param {"dark" | "light"} mode
 * @returns {import("shiki").ThemeRegistration}
 */
function theme(mode) {
  const dark = mode === "dark";
  const c = dark
    ? {
        bg: "#0c0c0f",
        fg: "#e4e4e7",
        comment: "#8b8b96",
        keyword: "#c4b5fd",
        string: "#6ee7b7",
        fn: "#93c5fd",
        type: "#fcd38d",
        constant: "#fda4af",
        property: "#d4d4d8",
        param: "#a5b4fc",
        decorator: "#4be3a6",
        punct: "#a1a1aa",
      }
    : {
        bg: "#fafafa",
        fg: "#18181b",
        comment: "#6e6e78",
        keyword: "#6d28d9",
        string: "#047857",
        fn: "#1d4ed8",
        type: "#a14a06",
        constant: "#be123c",
        property: "#3f3f46",
        param: "#4338ca",
        decorator: "#047a52",
        punct: "#52525b",
      };
  return {
    name: `cyphra-${mode}`,
    type: mode,
    colors: { "editor.background": c.bg, "editor.foreground": c.fg },
    tokenColors: [
      { settings: { foreground: c.fg } },
      {
        scope: ["comment", "punctuation.definition.comment"],
        settings: { foreground: c.comment, fontStyle: "italic" },
      },
      {
        scope: [
          "keyword",
          "storage",
          "storage.type",
          "storage.modifier",
          "keyword.control",
          "keyword.operator.new",
          "keyword.operator.expression",
        ],
        settings: { foreground: c.keyword },
      },
      {
        scope: ["keyword.operator", "punctuation", "meta.brace", "meta.delimiter"],
        settings: { foreground: c.punct },
      },
      {
        scope: ["string", "string.template", "punctuation.definition.string"],
        settings: { foreground: c.string },
      },
      {
        scope: [
          "entity.name.function",
          "support.function",
          "meta.function-call entity.name.function",
          "entity.name.command",
          "support.function.builtin",
        ],
        settings: { foreground: c.fn },
      },
      {
        scope: [
          "entity.name.type",
          "entity.name.class",
          "support.type",
          "support.class",
          "entity.other.inherited-class",
          "support.type.primitive",
        ],
        settings: { foreground: c.type },
      },
      {
        scope: [
          "constant",
          "constant.numeric",
          "constant.language",
          "variable.language",
          "support.constant",
        ],
        settings: { foreground: c.constant },
      },
      {
        scope: [
          "variable.other.property",
          "variable.other.object.property",
          "meta.object-literal.key",
          "support.type.property-name",
          "entity.name.tag.yaml",
          "entity.other.attribute-name",
        ],
        settings: { foreground: c.property },
      },
      {
        scope: ["variable.parameter", "variable.other.option", "constant.other.option"],
        settings: { foreground: c.param },
      },
      {
        scope: ["entity.name.function.decorator", "meta.decorator", "punctuation.decorator"],
        settings: { foreground: c.decorator },
      },
      { scope: ["entity.name.tag"], settings: { foreground: c.keyword } },
      { scope: ["markup.bold"], settings: { fontStyle: "bold" } },
      { scope: ["markup.italic"], settings: { fontStyle: "italic" } },
    ],
  };
}

export const cyphraDark = theme("dark");
export const cyphraLight = theme("light");
