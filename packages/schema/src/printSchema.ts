import type { Decorator, ModelAttribute, NodeField, ScalarTypeRef, SchemaDocument } from "./ast.js";

function formatScalarType(t: ScalarTypeRef): string {
  if (t.name === "Vector") {
    return `Vector(${t.dimensions ?? 0})${t.optional ? "?" : ""}`;
  }
  const name = t.name === "Enum" ? (t.enum ?? "") : t.name;
  if (t.list) {
    return `${name}[]`;
  }
  return t.optional ? `${name}?` : name;
}

function formatDecoratorValue(v: Decorator["args"][number]["value"]): string {
  if (v.kind === "string") {
    return JSON.stringify(v.value);
  }
  if (v.kind === "number" && v.raw !== undefined) {
    return v.raw;
  }
  return String(v.value);
}

/**
 * Serialize a decorator back to `.cyphra` surface syntax.
 *
 * @param d - Parsed decorator.
 */
export function formatDecorator(d: Decorator): string {
  if (d.name === "default") {
    const fnArg = d.args.find((a) => a.key === "fn");
    if (fnArg && fnArg.value.kind === "identifier") {
      return `@default(${fnArg.value.value}())`;
    }
    const valueArg = d.args.find((a) => a.key === "value");
    if (valueArg) {
      return `@default(${formatDecoratorValue(valueArg.value)})`;
    }
  }
  if (d.args.length === 0) {
    return `@${d.name}`;
  }
  const inner = d.args.map((a) => `${a.key}: ${formatDecoratorValue(a.value)}`).join(", ");
  return `@${d.name}(${inner})`;
}

/**
 * Serialize a model-level attribute back to `.cyphra` surface syntax, e.g.
 * `@@fulltext([title, body], name: "postSearch")`.
 *
 * @param a - Parsed model attribute.
 */
export function formatModelAttribute(a: ModelAttribute): string {
  const parts = [
    ...(a.fields ? [`[${a.fields.join(", ")}]`] : []),
    ...a.args.map((x) => `${x.key}: ${formatDecoratorValue(x.value)}`),
  ];
  return parts.length ? `@@${a.name}(${parts.join(", ")})` : `@@${a.name}`;
}

function attributeLines(attributes: readonly ModelAttribute[] | undefined): string[] {
  if (!attributes?.length) return [];
  return ["", ...attributes.map((a) => `  ${formatModelAttribute(a)}`)];
}

function formatScalarField(f: Extract<NodeField, { kind: "Scalar" }>): string {
  const decs = f.decorators.map(formatDecorator).join(" ");
  const base = `${f.name} ${formatScalarType(f.type)}`;
  return decs ? `${base} ${decs}` : base;
}

function formatRelationalField(f: Extract<NodeField, { kind: "Relational" }>): string {
  let typeSuffix = f.target;
  if (f.cardinality === "many") {
    typeSuffix += "[]";
  } else if (f.optional) {
    typeSuffix += "?";
  }
  const decs = f.decorators.map(formatDecorator).join(" ");
  return `${f.name} ${typeSuffix} ${decs}`;
}

function formatNodeField(f: NodeField): string {
  return f.kind === "Scalar" ? formatScalarField(f) : formatRelationalField(f);
}

/**
 * Pretty-print a schema document as `.cyphra` text (comments are not preserved).
 *
 * @param doc - Parsed document.
 * @returns UTF-8 source suitable for review, diffs, or round-trip testing.
 */
export function printSchemaDocument(doc: SchemaDocument): string {
  const blocks: string[] = [];
  for (const d of doc.declarations) {
    if (d.kind === "Enum") {
      blocks.push([`enum ${d.name} {`, ...d.values.map((v) => `  ${v}`), "}"].join("\n"));
    } else if (d.kind === "Node") {
      const lines = [
        `node ${d.name} {`,
        ...d.fields.map((f) => `  ${formatNodeField(f)}`),
        ...attributeLines(d.attributes),
        "}",
      ];
      blocks.push(lines.join("\n"));
    } else {
      const fieldLines = d.fields.map((f) => `  ${formatScalarField(f)}`);
      const lines = [
        `relationship ${d.name} {`,
        `  type ${JSON.stringify(d.relType)}`,
        `  from ${d.from}`,
        `  to ${d.to}`,
        ...fieldLines,
        ...attributeLines(d.attributes),
        "}",
      ];
      blocks.push(lines.join("\n"));
    }
  }
  return `${blocks.join("\n\n")}\n`;
}
