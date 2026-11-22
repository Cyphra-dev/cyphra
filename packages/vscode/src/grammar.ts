/**
 * TextMate grammar for `.cyphra` files, generated so that the built-in type names come from
 * `SCALAR_TYPE_NAMES` in `@cyphra/schema` (a new scalar type is highlighted without editing this
 * file). `scripts/build.mts` writes it to `syntaxes/cyphra.tmLanguage.json`.
 */

type Rule = Record<string, unknown>;

const IDENT = "[A-Za-z_][A-Za-z0-9_]*";

export const SCOPE_NAME = "source.cyphra";

/** Build the grammar for the given built-in scalar type names (`Vector(N)` is always known). */
export function buildGrammar(scalarTypes: readonly string[]): Rule {
  const types = [...scalarTypes].sort((a, b) => b.length - a.length).join("|");
  const fieldType = {
    // `name Type`, `name Type?`, `name Type[]`, `name Vector(1536)?`
    match: `^\\s*(${IDENT})\\s+(?:\\b(${types})\\b|\\b(Vector)\\s*(\\()\\s*(\\d+)\\s*(\\))|(${IDENT}))(\\[\\]|\\?)?`,
    captures: {
      1: { name: "variable.other.property.cyphra" },
      2: { name: "support.type.primitive.cyphra" },
      3: { name: "support.type.primitive.cyphra" },
      4: { name: "punctuation.definition.parameters.begin.cyphra" },
      5: { name: "constant.numeric.integer.cyphra" },
      6: { name: "punctuation.definition.parameters.end.cyphra" },
      7: { name: "entity.name.type.cyphra" },
      8: { name: "keyword.operator.type.modifier.cyphra" },
    },
  };
  // `node X implements A, B { … }` / `interface B extends A { … }`: same body, with an optional
  // `implements` / `extends` list in the header.
  const nodeLike = (keyword: "node" | "interface") => ({
    begin: `\\b(${keyword})\\b\\s*(${IDENT})?(?:\\s+(implements|extends)\\b\\s*((?:${IDENT})(?:\\s*,\\s*${IDENT})*)?)?`,
    beginCaptures: {
      1: { name: `keyword.declaration.${keyword}.cyphra` },
      2: { name: `entity.name.type.${keyword}.cyphra` },
      3: {
        patterns: [
          { match: "implements", name: "keyword.other.implements.cyphra" },
          { match: "extends", name: "keyword.other.extends.cyphra" },
        ],
      },
      4: {
        patterns: [
          { match: IDENT, name: "entity.name.type.interface.cyphra" },
          { match: ",", name: "punctuation.separator.cyphra" },
        ],
      },
    },
    end: "\\}",
    endCaptures: { 0: { name: "punctuation.definition.block.end.cyphra" } },
    patterns: [
      { include: "#comment" },
      { match: "\\{", name: "punctuation.definition.block.begin.cyphra" },
      { include: "#field" },
      { include: "#attributes" },
    ],
  });
  return {
    $schema: "https://raw.githubusercontent.com/martinring/tmlanguage/master/tmlanguage.json",
    name: "Cyphra",
    scopeName: SCOPE_NAME,
    fileTypes: ["cyphra"],
    patterns: [
      { include: "#comment" },
      { include: "#enum" },
      { include: "#node" },
      { include: "#interface" },
      { include: "#relationship" },
    ],
    repository: {
      comment: {
        match: "(//).*$",
        name: "comment.line.double-slash.cyphra",
        captures: { 1: { name: "punctuation.definition.comment.cyphra" } },
      },
      declarationName: {
        match: IDENT,
        name: "entity.name.type.cyphra",
      },
      enum: {
        begin: `\\b(enum)\\b\\s*(${IDENT})?`,
        beginCaptures: {
          1: { name: "keyword.declaration.enum.cyphra" },
          2: { name: "entity.name.type.enum.cyphra" },
        },
        end: "\\}",
        endCaptures: { 0: { name: "punctuation.definition.block.end.cyphra" } },
        patterns: [
          { include: "#comment" },
          { match: "\\{", name: "punctuation.definition.block.begin.cyphra" },
          { match: ",", name: "punctuation.separator.cyphra" },
          { match: IDENT, name: "variable.other.enummember.cyphra" },
        ],
      },
      node: nodeLike("node"),
      interface: nodeLike("interface"),
      relationship: {
        begin: `\\b(relationship)\\b\\s*(${IDENT})?`,
        beginCaptures: {
          1: { name: "keyword.declaration.relationship.cyphra" },
          2: { name: "entity.name.type.relationship.cyphra" },
        },
        end: "\\}",
        endCaptures: { 0: { name: "punctuation.definition.block.end.cyphra" } },
        patterns: [
          { include: "#comment" },
          { match: "\\{", name: "punctuation.definition.block.begin.cyphra" },
          {
            match: `^\\s*(type)\\b`,
            captures: { 1: { name: "keyword.other.relationship-type.cyphra" } },
          },
          {
            match: `^\\s*(from|to)\\s+(${IDENT})`,
            captures: {
              1: { name: "keyword.other.endpoint.cyphra" },
              2: { name: "entity.name.type.cyphra" },
            },
          },
          { include: "#field" },
          { include: "#attributes" },
        ],
      },
      field: fieldType,
      attributes: {
        patterns: [
          { include: "#string" },
          { include: "#modelAttribute" },
          { include: "#decorator" },
          { include: "#argument" },
          { include: "#value" },
        ],
      },
      modelAttribute: {
        match: `(@@)(${IDENT})`,
        captures: {
          1: { name: "punctuation.definition.decorator.cyphra" },
          2: { name: "entity.name.function.decorator.model.cyphra" },
        },
      },
      decorator: {
        match: `(@)(${IDENT})`,
        captures: {
          1: { name: "punctuation.definition.decorator.cyphra" },
          2: { name: "entity.name.function.decorator.cyphra" },
        },
      },
      argument: {
        match: `\\b(${IDENT})\\s*(:)`,
        captures: {
          1: { name: "variable.parameter.cyphra" },
          2: { name: "punctuation.separator.key-value.cyphra" },
        },
      },
      string: {
        begin: '"',
        beginCaptures: { 0: { name: "punctuation.definition.string.begin.cyphra" } },
        end: '"|$',
        endCaptures: { 0: { name: "punctuation.definition.string.end.cyphra" } },
        name: "string.quoted.double.cyphra",
        patterns: [{ match: '\\\\["\\\\n]', name: "constant.character.escape.cyphra" }],
      },
      value: {
        patterns: [
          { match: "\\b(true|false)\\b", name: "constant.language.boolean.cyphra" },
          { match: "\\b(OUT|IN)\\b", name: "constant.language.direction.cyphra" },
          {
            match: `\\b(${IDENT})\\s*(\\()\\s*(\\))`,
            captures: {
              1: { name: "support.function.cyphra" },
              2: { name: "punctuation.definition.parameters.begin.cyphra" },
              3: { name: "punctuation.definition.parameters.end.cyphra" },
            },
          },
          { match: "-?\\b\\d+(\\.\\d+)?\\b", name: "constant.numeric.cyphra" },
          { match: "[()\\[\\],]", name: "punctuation.cyphra" },
          { match: IDENT, name: "variable.other.constant.cyphra" },
        ],
      },
    },
  };
}
