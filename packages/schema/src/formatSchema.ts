import type {
  Decorator,
  DecoratorArg,
  ModelAttribute,
  NodeField,
  SchemaComment,
  SchemaDocument,
  SourceRange,
} from "./ast.js";
import { parseSchemaSyntax } from "./parseSchema.js";
import { formatRelationalType, formatScalarType, nodeHeader } from "./printSchema.js";

/** Options of {@link formatSchema}. */
export type FormatSchemaOptions = {
  /** Indentation of block contents (default two spaces). */
  readonly indent?: string;
};

/** One printable line of a block (a field, an attribute, an enum value, a header line). */
type Item = {
  readonly start: number;
  readonly end: number;
  readonly endLine: number;
  /** Field columns, aligned within a group of consecutive fields; `undefined` for other lines. */
  readonly columns?: readonly [name: string, type: string, decorators: string];
  readonly text?: string;
  /** Printed after the fields, separated from them by a blank line (model attributes). */
  readonly trailer?: boolean;
  leading: SchemaComment[];
  trailing?: SchemaComment;
};

type Block = {
  readonly header: string;
  readonly start: number;
  readonly end: number;
  readonly startLine: number;
  readonly endLine: number;
  readonly items: Item[];
  /** A one-line declaration (`union X = A | B`): no body, no closing brace. */
  readonly oneLine?: true;
  leading: SchemaComment[];
  headerComment?: SchemaComment;
  dangling: SchemaComment[];
  trailing?: SchemaComment;
};

function range(loc: SourceRange | undefined): SourceRange {
  if (!loc) throw new Error("formatSchema: missing source range (parser bug).");
  return loc;
}

/**
 * Reformat `.cyphra` source text: one item per line, two-space indentation, one blank line
 * between declarations, field names and types aligned within groups of consecutive fields, model
 * attributes after the fields. Unlike {@link printSchemaDocument}, `//` comments and single blank
 * lines between items are kept, and literals are kept as written.
 *
 * The result is checked: it must parse to the same AST with the same comments, otherwise this
 * throws instead of returning text that would change the schema.
 *
 * @param source - `.cyphra` source (it needs to parse, not to pass semantic validation).
 * @throws {SyntaxError} When the source does not parse.
 */
export function formatSchema(source: string, options?: FormatSchemaOptions): string {
  const indent = options?.indent ?? "  ";
  const doc = parseSchemaSyntax(source, { locations: true });
  const slice = (loc: SourceRange | undefined) =>
    source.slice(range(loc).start.offset, range(loc).end.offset);

  const formatValue = (a: DecoratorArg) => slice(a.valueLoc);
  const formatDec = (d: Decorator): string => {
    if (d.name === "default" && d.args.length === 1 && !d.args[0]!.keyLoc) {
      const a = d.args[0]!;
      return a.key === "fn" && a.value.kind === "identifier"
        ? `@default(${a.value.value}())`
        : `@default(${formatValue(a)})`;
    }
    if (d.args.length === 0) return `@${d.name}`;
    // Positional arguments (`@length(3, 20)`) have no key in the source: keep them positional.
    const arg = (a: DecoratorArg) => (a.keyLoc ? `${a.key}: ${formatValue(a)}` : formatValue(a));
    return `@${d.name}(${d.args.map(arg).join(", ")})`;
  };
  const formatAttr = (a: ModelAttribute): string => {
    const parts = [
      ...(a.fields ? [`[${a.fields.join(", ")}]`] : []),
      ...a.args.map((x) => `${x.key}: ${formatValue(x)}`),
    ];
    return parts.length ? `@@${a.name}(${parts.join(", ")})` : `@@${a.name}`;
  };
  const fieldItem = (f: NodeField): Item => {
    const loc = range(f.loc);
    const type = f.kind === "Scalar" ? formatScalarType(f.type) : formatRelationalType(f);
    return {
      start: loc.start.offset,
      end: loc.end.offset,
      endLine: loc.end.line,
      columns: [f.name, type, f.decorators.map(formatDec).join(" ")],
      leading: [],
    };
  };
  const lineItem = (loc: SourceRange, text: string, trailer = false): Item => ({
    start: loc.start.offset,
    end: loc.end.offset,
    endLine: loc.end.line,
    text,
    trailer,
    leading: [],
  });

  const blocks: Block[] = doc.declarations.map((d) => {
    const loc = range(d.loc);
    let items: Item[];
    let header: string;
    if (d.kind === "Union") {
      return {
        header: `union ${d.name} = ${d.members.join(" | ")}`,
        start: loc.start.offset,
        end: loc.end.offset,
        startLine: loc.start.line,
        endLine: loc.end.line,
        items: [],
        oneLine: true,
        leading: [],
        dangling: [],
      };
    }
    if (d.kind === "Enum") {
      header = `enum ${d.name} {`;
      items = d.values.map((v, i) => lineItem(range(d.valueLocs?.[i]), v));
    } else {
      const attrs = (d.attributes ?? []).map((a) => lineItem(range(a.loc), formatAttr(a), true));
      const fields: Item[] = d.fields.map(fieldItem);
      if (d.kind === "Node") {
        header = nodeHeader(d);
        items = [...fields, ...attrs];
      } else {
        header = `relationship ${d.name} {`;
        // The short form (`relationship AUTHORED { … }`) has no `type` / `from` / `to` lines.
        const ends =
          d.from === undefined
            ? []
            : [
                lineItem(range(d.relTypeLoc), `type ${slice(d.relTypeLoc)}`),
                lineItem(range(d.fromLoc), `from ${d.from}`),
                lineItem(range(d.toLoc), `to ${d.to}`),
              ];
        items = [...ends, ...fields, ...attrs];
      }
    }
    return {
      header,
      start: loc.start.offset,
      end: loc.end.offset,
      startLine: loc.start.line,
      endLine: loc.end.line,
      items,
      leading: [],
      dangling: [],
    };
  });

  const fileDangling: SchemaComment[] = [];
  const attachTrailing = (target: Item | Block, c: SchemaComment) => {
    if (!target.trailing) target.trailing = c;
    // A second comment inside one item (a field split over lines) moves before it.
    else target.leading.push(c);
  };

  for (const c of doc.comments ?? []) {
    const at = c.loc.start.offset;
    const block = blocks.find((b) => at > b.start && at < b.end);
    if (!block) {
      const before = blocks.filter((b) => b.end <= at).at(-1);
      if (before && before.endLine === c.loc.start.line) attachTrailing(before, c);
      else {
        const next = blocks.find((b) => b.start > at);
        if (next) next.leading.push(c);
        else fileDangling.push(c);
      }
      continue;
    }
    const sorted = [...block.items].sort((a, b) => a.start - b.start);
    const inside = sorted.find((i) => at > i.start && at < i.end);
    if (inside) {
      attachTrailing(inside, c);
      continue;
    }
    const sameLine = sorted.filter((i) => i.end <= at && i.endLine === c.loc.start.line).at(-1);
    if (sameLine) attachTrailing(sameLine, c);
    else if (c.loc.start.line === block.startLine && !block.headerComment) block.headerComment = c;
    else {
      const next = sorted.find((i) => i.start > at);
      if (next) next.leading.push(c);
      else block.dangling.push(c);
    }
  }

  // A blank line separated this offset from the previous non-blank text.
  const blankBefore = (offset: number): boolean => {
    let newlines = 0;
    for (let i = offset - 1; i >= 0; i--) {
      const ch = source[i]!;
      if (ch === "\n") newlines++;
      else if (ch !== " " && ch !== "\t" && ch !== "\r") break;
    }
    return newlines >= 2;
  };
  const withTrailing = (text: string, c: SchemaComment | undefined) =>
    c ? `${text} ${c.text.trimEnd()}` : text;

  const out: string[] = [];
  // Comments (sorted) then the element, keeping one blank line where the source had any.
  const emitLeading = (comments: SchemaComment[], prefix: string, first: boolean): boolean => {
    for (const c of [...comments].sort((a, b) => a.loc.start.offset - b.loc.start.offset)) {
      if (!first && blankBefore(c.loc.start.offset)) out.push("");
      out.push(`${prefix}${c.text.trimEnd()}`);
      first = false;
    }
    return first;
  };

  blocks.forEach((b, bi) => {
    if (bi > 0) out.push("");
    if (b.oneLine) {
      // Comments between the members go before the line, a trailing one after it.
      const trailing = b.trailing ?? b.headerComment;
      const before = [...b.leading, ...b.dangling];
      if (b.trailing && b.headerComment) before.push(b.headerComment);
      if (!emitLeading(before, "", true) && blankBefore(b.start)) out.push("");
      out.push(withTrailing(b.header, trailing));
      return;
    }
    if (!emitLeading(b.leading, "", true) && blankBefore(b.start)) out.push("");
    out.push(withTrailing(b.header, b.headerComment));

    const ordered = [...b.items.filter((i) => !i.trailer), ...b.items.filter((i) => i.trailer)];
    // Groups of consecutive fields (split by blank lines) share column widths.
    const groupOf = new Map<Item, number>();
    let group = 0;
    let firstInBlock = true;
    const breaks = new Map<Item, boolean>();
    let seenTrailer = false;
    for (const item of ordered) {
      const startOf = item.leading[0]?.loc.start.offset ?? item.start;
      let blank = !firstInBlock && blankBefore(startOf);
      if (item.trailer && !seenTrailer) {
        blank = !firstInBlock;
        seenTrailer = true;
      }
      breaks.set(item, blank);
      if (blank || !item.columns) group++;
      groupOf.set(item, group);
      if (!item.columns) group++;
      firstInBlock = false;
    }
    const widths = new Map<number, [number, number]>();
    for (const item of ordered) {
      if (!item.columns) continue;
      const g = groupOf.get(item)!;
      const [n, t] = widths.get(g) ?? [0, 0];
      widths.set(g, [
        Math.max(n, item.columns[0].length),
        item.columns[2] ? Math.max(t, item.columns[1].length) : t,
      ]);
    }
    for (const item of ordered) {
      if (breaks.get(item)) out.push("");
      emitLeading(item.leading, indent, true);
      if (item.leading.length && blankBefore(item.start)) out.push("");
      let text = item.text ?? "";
      if (item.columns) {
        const [nameW, typeW] = widths.get(groupOf.get(item)!)!;
        const [name, type, decs] = item.columns;
        text = decs
          ? `${name.padEnd(nameW)} ${type.padEnd(typeW)} ${decs}`
          : `${name.padEnd(nameW)} ${type}`;
      }
      out.push(withTrailing(`${indent}${text}`, item.trailing));
    }
    emitLeading(b.dangling, indent, ordered.length === 0);
    out.push(withTrailing("}", b.trailing));
  });
  if (fileDangling.length) {
    if (blocks.length) out.push("");
    emitLeading(fileDangling, "", true);
  }
  const formatted = out.length ? `${out.join("\n")}\n` : "";
  assertSameSchema(doc, formatted);
  return formatted;
}

function stripLocations(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripLocations);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === "comments" || k === "loc" || k.endsWith("Loc") || k.endsWith("Locs")) continue;
      out[k] = stripLocations(v);
    }
    return out;
  }
  return value;
}

function assertSameSchema(before: SchemaDocument, formatted: string): void {
  const after = parseSchemaSyntax(formatted, { locations: true });
  const texts = (d: SchemaDocument) => (d.comments ?? []).map((c) => c.text.trimEnd()).sort();
  if (
    JSON.stringify(stripLocations(before)) !== JSON.stringify(stripLocations(after)) ||
    JSON.stringify(texts(before)) !== JSON.stringify(texts(after))
  ) {
    throw new Error(
      "formatSchema: formatting would change the schema or its comments (please report this).",
    );
  }
}
