import type {
  Declaration,
  Decorator,
  ModelAttribute,
  NodeField,
  SourceRange,
} from "@cyphra/schema";
import { span, typeNameSpan, type Analysis, type Span } from "./analysis.js";
import { decoratorDoc, decoratorMarkdown, KEYWORD_DOCS, typeDoc } from "./docs.js";
import { declarationNamed, occurrenceAt } from "./symbols.js";

export type HoverResult = { readonly markdown: string; readonly span: Span };

const within = (offset: number, s: Span | undefined): s is Span =>
  s !== undefined && offset >= s.start && offset <= s.end;

const MAX_SUMMARY_LINES = 30;

/** The declaration's source as a fenced `cyphra` block (long ones are cut). */
export function declarationSummary(text: string, d: Declaration): string {
  const s = span(d.loc);
  const lines = (s ? text.slice(s.start, s.end) : `${d.kind.toLowerCase()} ${d.name}`).split("\n");
  const body =
    lines.length > MAX_SUMMARY_LINES
      ? [...lines.slice(0, MAX_SUMMARY_LINES), "  // …", "}"]
      : lines;
  return "```cyphra\n" + body.join("\n") + "\n```";
}

function fieldType(f: NodeField): string {
  if (f.kind === "Relational") {
    return f.cardinality === "many" ? `${f.target}[]` : `${f.target}${f.optional ? "?" : ""}`;
  }
  const t = f.type;
  const name =
    t.name === "Enum"
      ? (t.enum ?? "")
      : t.name === "Vector"
        ? `Vector(${t.dimensions ?? 0})`
        : t.name;
  return t.list ? `${name}[]` : `${name}${t.optional ? "?" : ""}`;
}

function fieldMarkdown(a: Analysis, owner: Declaration, f: NodeField): string {
  const head = "```cyphra\n" + `${f.name} ${fieldType(f)}` + "\n```";
  const what = owner.kind === "Node" ? (owner.abstract ? "interface" : "node") : "relationship";
  const parts = [head, `Field of ${what} **${owner.name}**.`];
  if (f.kind === "Relational") {
    const rel = f.decorators.find((d) => d.name === "relationship");
    const type = rel?.args.find((x) => x.key === "type")?.value;
    const dir = rel?.args.find((x) => x.key === "direction")?.value;
    const rule = rel?.args.find((x) => x.key === "onDelete")?.value;
    const many = f.cardinality === "many" ? "many" : f.optional ? "zero or one" : "one";
    parts.push(
      `Relation to ${many} **${f.target}**` +
        (type?.kind === "string" ? ` through \`${type.value}\`` : "") +
        ` (${dir?.kind === "identifier" ? dir.value : "OUT"}).`,
    );
    parts.push(
      `On delete: **${rule?.kind === "identifier" ? rule.value : "SetNull"}** (${
        rule?.kind === "identifier" && rule.value === "Cascade"
          ? `deleting a ${owner.name} deletes its ${f.target} nodes`
          : rule?.kind === "identifier" && rule.value === "Restrict"
            ? `a ${owner.name} linked to ${f.target} nodes cannot be deleted`
            : `deleting a ${owner.name} removes the edges only`
      }).`,
    );
    const target = a.doc && declarationNamed(a.doc, f.target);
    if (target) parts.push(declarationSummary(a.text, target));
  } else if (f.type.name === "Enum" && f.type.enum) {
    const target = a.doc && declarationNamed(a.doc, f.type.enum);
    if (target) parts.push(declarationSummary(a.text, target));
  }
  return parts.join("\n\n");
}

function decoratorHover(
  offset: number,
  d: Decorator | ModelAttribute,
  model: boolean,
): HoverResult | undefined {
  const loc = span(d.loc);
  if (!within(offset, loc)) return undefined;
  const doc = decoratorDoc(d.name, model);
  for (const arg of d.args) {
    const key = span(arg.keyLoc);
    const argDoc = doc?.args?.find((x) => x.name === arg.key);
    if (within(offset, key) && argDoc) {
      return { markdown: `**${arg.key}**: ${argDoc.doc}`, span: key };
    }
  }
  const nameSpan = { start: loc.start, end: loc.start + (model ? 2 : 1) + d.name.length };
  if (!within(offset, nameSpan)) return undefined;
  return {
    markdown: doc
      ? decoratorMarkdown(doc)
      : `**${model ? "@@" : "@"}${d.name}**: unknown ${model ? "model attribute" : "decorator"}.`,
    span: nameSpan,
  };
}

function keywordSpan(loc: SourceRange | undefined, keyword: string): Span | undefined {
  const s = span(loc);
  return s ? { start: s.start, end: s.start + keyword.length } : undefined;
}

/** Hover at `offset`: types, models and enums, fields, decorators and their arguments. */
export function hoverAt(a: Analysis, offset: number): HoverResult | undefined {
  const doc = a.doc;
  if (!doc) return undefined;
  const o = occurrenceAt(doc, offset);
  if (o) {
    const d = declarationNamed(doc, o.name);
    return {
      markdown: d ? declarationSummary(a.text, d) : `Unknown type **${o.name}**.`,
      span: o,
    };
  }
  for (const d of doc.declarations) {
    const declSpan = span(d.loc);
    if (!within(offset, declSpan)) continue;
    const keyword = d.kind === "Node" && d.abstract ? "interface" : d.kind.toLowerCase();
    const kw = keywordSpan(d.loc, keyword);
    if (within(offset, kw)) return { markdown: KEYWORD_DOCS[keyword] ?? keyword, span: kw };
    if (d.kind === "Enum") return undefined;
    // The `implements` keyword, between the name and the first interface name.
    const name = span(d.nameLoc);
    const first = span(d.kind === "Node" ? d.implementsLocs?.[0] : undefined);
    if (name && first) {
      const between = a.text.slice(name.end, first.start);
      const at = between.indexOf("implements");
      const s = { start: name.end + at, end: name.end + at + "implements".length };
      if (at >= 0 && within(offset, s)) {
        return { markdown: KEYWORD_DOCS.implements!, span: s };
      }
    }
    for (const f of d.fields) {
      if (!within(offset, span(f.loc))) continue;
      const name = span(f.nameLoc);
      if (within(offset, name)) return { markdown: fieldMarkdown(a, d, f), span: name };
      const typeName = typeNameSpan(f);
      if (
        within(offset, span(f.typeLoc)) &&
        typeName &&
        f.kind === "Scalar" &&
        f.type.name !== "Enum"
      ) {
        return { markdown: typeDoc(f.type.name), span: span(f.typeLoc)! };
      }
      for (const dec of f.decorators) {
        const h = decoratorHover(offset, dec, false);
        if (h) return h;
      }
      return undefined;
    }
    for (const attr of d.attributes ?? []) {
      const h = decoratorHover(offset, attr, true);
      if (h) return h;
    }
    if (d.kind === "Relationship") {
      const t = span(d.relTypeLoc);
      if (within(offset, t)) {
        return { markdown: `Neo4j relationship type of **${d.name}**.`, span: t };
      }
    }
  }
  return undefined;
}
