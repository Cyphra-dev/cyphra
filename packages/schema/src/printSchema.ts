import type { Decorator, NodeField, ScalarTypeRef, SchemaDocument } from "./ast.js";

function formatScalarType(t: ScalarTypeRef): string {
  return t.optional ? `${t.name}?` : t.name;
}

function formatDecoratorValue(v: Decorator["args"][number]["value"]): string {
  if (v.kind === "string") {
    return JSON.stringify(v.value);
  }
  return v.value;
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
  }
  if (d.args.length === 0) {
    return `@${d.name}`;
  }
  const inner = d.args.map((a) => `${a.key}: ${formatDecoratorValue(a.value)}`).join(", ");
  return `@${d.name}(${inner})`;
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
    if (d.kind === "Node") {
      const lines = [`node ${d.name} {`, ...d.fields.map((f) => `  ${formatNodeField(f)}`), "}"];
      blocks.push(lines.join("\n"));
    } else {
      const fieldLines = d.fields.map((f) => `  ${formatScalarField(f)}`);
      const lines = [
        `relationship ${d.name} {`,
        `  type ${JSON.stringify(d.relType)}`,
        `  from ${d.from}`,
        `  to ${d.to}`,
        ...fieldLines,
        "}",
      ];
      blocks.push(lines.join("\n"));
    }
  }
  return `${blocks.join("\n\n")}\n`;
}
