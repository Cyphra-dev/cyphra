import { formatSchema } from "@cyphra/schema";
import { span, type Analysis, type Span } from "./analysis.js";

export type OutlineKind = "node" | "relationship" | "enum" | "field" | "enumMember" | "attribute";

/** An editor-neutral document symbol (the server maps it to an LSP `DocumentSymbol`). */
export type OutlineSymbol = {
  readonly name: string;
  readonly kind: OutlineKind;
  readonly detail?: string;
  /** The whole element. */
  readonly span: Span;
  /** The name (contained in `span`). */
  readonly selection: Span;
  readonly children: readonly OutlineSymbol[];
};

/** Document outline: from the AST when the text parses, else from the tolerant scanner. */
export function outline(a: Analysis): OutlineSymbol[] {
  const doc = a.doc;
  if (!doc) {
    return a.scanned.map((d) => ({
      name: d.name,
      kind: d.kind,
      span: { start: d.keyword.start, end: Math.max(d.end, d.nameToken.end) },
      selection: { start: d.nameToken.start, end: d.nameToken.end },
      children: [],
    }));
  }
  const out: OutlineSymbol[] = [];
  for (const d of doc.declarations) {
    const whole = span(d.loc);
    const name = span(d.nameLoc);
    if (!whole || !name) continue;
    const children: OutlineSymbol[] = [];
    if (d.kind === "Enum") {
      d.values.forEach((v, i) => {
        const s = span(d.valueLocs?.[i]);
        if (s) children.push({ name: v, kind: "enumMember", span: s, selection: s, children: [] });
      });
    } else {
      for (const f of d.fields) {
        const s = span(f.loc);
        const n = span(f.nameLoc);
        const t = span(f.typeLoc);
        if (!s || !n) continue;
        children.push({
          name: f.name,
          kind: "field",
          ...(t ? { detail: a.text.slice(t.start, t.end) } : {}),
          span: s,
          selection: n,
          children: [],
        });
      }
      for (const attr of d.attributes ?? []) {
        const s = span(attr.loc);
        if (!s) continue;
        children.push({
          name: `@@${attr.name}`,
          kind: "attribute",
          ...(attr.fields ? { detail: attr.fields.join(", ") } : {}),
          span: s,
          selection: { start: s.start, end: s.start + 2 + attr.name.length },
          children: [],
        });
      }
    }
    out.push({
      name: d.name,
      kind: d.kind === "Node" ? "node" : d.kind === "Relationship" ? "relationship" : "enum",
      ...(d.kind === "Relationship" ? { detail: `${d.from} -[${d.relType}]-> ${d.to}` } : {}),
      span: whole,
      selection: name,
      children,
    });
  }
  return out;
}

/**
 * The formatted text (comments kept, see `formatSchema`), or `undefined` when the text does not
 * parse or is already formatted.
 */
export function formatText(text: string): string | undefined {
  try {
    const out = formatSchema(text);
    return out === text ? undefined : out;
  } catch {
    return undefined;
  }
}
