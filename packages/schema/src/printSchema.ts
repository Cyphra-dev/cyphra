import type {
  Decorator,
  ModelAttribute,
  NodeDeclaration,
  NodeField,
  ScalarTypeRef,
  SchemaDocument,
} from "./ast.js";

/**
 * A `.cyphra` string literal: the grammar only knows the `\\`, `\"` and `\n` escapes, so other
 * characters (tabs, control characters) stay as they are (`JSON.stringify` would escape them).
 */
export function quoteSchemaString(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}

/** @internal Surface syntax of a scalar field type (`String?`, `Vector(3)`, `Role[]`). */
export function formatScalarType(t: ScalarTypeRef): string {
  if (t.name === "Vector") {
    return `Vector(${t.dimensions ?? 0})${t.optional ? "?" : ""}`;
  }
  const name = t.name === "Enum" ? (t.enum ?? "") : t.name;
  if (t.list) {
    return `${name}[]`;
  }
  return t.optional ? `${name}?` : name;
}

/** Arguments a rule decorator prints positionally, in order. */
const PRINT_POSITIONAL: Readonly<Record<string, readonly string[]>> = {
  length: ["min", "max"],
  size: ["min", "max"],
  min: ["value"],
  max: ["value"],
  regex: ["pattern"],
};

function formatDecoratorValue(v: Decorator["args"][number]["value"]): string {
  if (v.kind === "string") {
    return quoteSchemaString(v.value);
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
  // Rule decorators print their leading arguments positionally (`@length(3, 20)`, `@min(0)`,
  // `@regex("^a")`) when given in that order; `@regex` flags stay named.
  const positional = PRINT_POSITIONAL[d.name] ?? [];
  let n = 0;
  while (n < d.args.length && n < positional.length && d.args[n]!.key === positional[n]) n++;
  const inner = d.args
    .map((a, i) =>
      i < n || a.key === ""
        ? formatDecoratorValue(a.value)
        : `${a.key}: ${formatDecoratorValue(a.value)}`,
    )
    .join(", ");
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

/** @internal Surface syntax of a relation field's type (`User`, `User?`, `Post[]`). */
export function formatRelationalType(f: Extract<NodeField, { kind: "Relational" }>): string {
  if (f.cardinality === "many") return `${f.target}[]`;
  return f.optional ? `${f.target}?` : f.target;
}

function formatRelationalField(f: Extract<NodeField, { kind: "Relational" }>): string {
  const decs = f.decorators.map(formatDecorator).join(" ");
  const base = `${f.name} ${formatRelationalType(f)}`;
  return decs ? `${base} ${decs}` : base;
}

/** @internal Opening line of a node or interface block (`node Employee implements Person {`). */
export function nodeHeader(d: NodeDeclaration): string {
  const impl = d.implements?.length ? ` implements ${d.implements.join(", ")}` : "";
  return `${d.abstract ? "interface" : "node"} ${d.name}${impl} {`;
}

function formatNodeField(f: NodeField): string {
  return f.kind === "Scalar" ? formatScalarField(f) : formatRelationalField(f);
}

/**
 * Pretty-print a schema document as `.cyphra` text (comments are not preserved: use
 * `formatSchema` to reformat source text and keep them).
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
        nodeHeader(d),
        ...d.fields.map((f) => `  ${formatNodeField(f)}`),
        ...attributeLines(d.attributes),
        "}",
      ];
      blocks.push(lines.join("\n"));
    } else {
      const fieldLines = d.fields.map((f) => `  ${formatScalarField(f)}`);
      const lines = [
        `relationship ${d.name} {`,
        `  type ${quoteSchemaString(d.relType)}`,
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
