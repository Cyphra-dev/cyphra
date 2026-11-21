/**
 * Shared by the schema importers (`cyphra import graphql`, `cyphra import prisma`): print an
 * {@link ImportResult} as `.cyphra` source, merge it into an existing schema, and format the
 * import report.
 *
 * @packageDocumentation
 */

import type {
  Declaration,
  ModelAttribute,
  NodeDeclaration,
  NodeField,
  SchemaDocument,
} from "../ast.js";
import { resolveSchema } from "../model.js";
import { parseSchema } from "../parseSchema.js";
import { formatModelAttribute, printSchemaDocument } from "../printSchema.js";

/** How serious a report entry is. */
export type ImportSeverity =
  /** Not converted: the type, field or attribute is missing from the Cyphra schema. */
  | "unsupported"
  /** Converted, but it behaves differently in Cyphra: review it. */
  | "changed"
  /** Setting of the source tool with no effect on the graph data model. */
  | "ignored";

/** One line of an import report. */
export type ImportIssue = {
  readonly severity: ImportSeverity;
  /** Location in the source schema: `Type` or `Type.field`. */
  readonly at: string;
  /** What it is about, e.g. `@cypher`, `Decimal`, `@@id`. */
  readonly feature: string;
  readonly message: string;
};

/** An issue before its location is attached. */
export type IssueDraft = Omit<ImportIssue, "at">;

/** What an importer produces: the converted schema, its report and inline notes. */
export type ImportResult = {
  readonly document: SchemaDocument;
  /** Everything that was not converted or behaves differently, in source order. */
  readonly issues: readonly ImportIssue[];
  /**
   * Comment lines to print inside a declaration (keyed by Cyphra declaration name), one per
   * field that was not converted.
   */
  readonly notes: ReadonlyMap<string, readonly string[]>;
};

/** Options of {@link printImportResult} and {@link mergeImportResult}. */
export type ImportPrintOptions = {
  /** First line of the file (or of the appended block), a `// …` comment naming the source. */
  readonly header: string;
};

/** One declaration as `.cyphra` text, with `// …` notes for fields that were not converted. */
function printDeclaration(decl: Declaration, notes: readonly string[] | undefined): string {
  const text = printSchemaDocument({ kind: "Document", declarations: [decl] }).trimEnd();
  if (!notes?.length) return text;
  const lines = text.split("\n");
  // After the last field: before the closing brace, or before the blank line and `@@…` attributes.
  const attributes = decl.kind === "Enum" ? undefined : decl.attributes;
  const attrs = attributes?.length ? attributes.length + 1 : 0;
  lines.splice(lines.length - 1 - attrs, 0, ...notes.map((n) => `  // ${n}`));
  return lines.join("\n");
}

function printDeclarations(result: ImportResult, decls: readonly Declaration[]): string {
  return decls.map((d) => printDeclaration(d, result.notes.get(d.name))).join("\n\n");
}

/** Header comment listing what to review (unsupported and changed entries). */
function reviewComment(issues: readonly ImportIssue[]): string[] {
  const review = issues.filter((i) => i.severity !== "ignored");
  if (review.length === 0) return [];
  return [
    "// Review before use (run the import again to see the full report):",
    ...review.map((i) => `// - ${i.at}: ${i.message}`),
  ];
}

/**
 * The imported schema as a new `.cyphra` file: the header, a comment listing what to review, then
 * the declarations.
 */
export function printImportResult(result: ImportResult, options: ImportPrintOptions): string {
  const head = [options.header, ...reviewComment(result.issues)].join("\n");
  const body = printDeclarations(result, result.document.declarations);
  return body ? `${head}\n\n${body}\n` : `${head}\n`;
}

/** One field formatted as a `.cyphra` line (without indentation). */
function formatField(field: NodeField): string {
  const text = printSchemaDocument({
    kind: "Document",
    declarations: [{ kind: "Node", name: "X", fields: [field] }],
  });
  return text.split("\n")[1]!.trim();
}

/** Offset of the closing brace of top-level `node <name> { … }`, skipping comments and strings. */
function nodeCloseBrace(source: string, name: string): number {
  let depth = 0;
  let inTarget = false;
  for (let i = 0; i < source.length; i++) {
    const c = source[i]!;
    if (c === "/" && source[i + 1] === "/") {
      while (i < source.length && source[i] !== "\n") i++;
      continue;
    }
    if (c === '"') {
      for (i++; i < source.length && source[i] !== '"'; i++) if (source[i] === "\\") i++;
      continue;
    }
    if (depth === 0 && /[A-Za-z_]/.test(c) && (i === 0 || !/[A-Za-z0-9_]/.test(source[i - 1]!))) {
      const m = /^(node|relationship)\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(source.slice(i));
      if (m) {
        inTarget = m[1] === "node" && m[2] === name;
        i += m[0].length - 1;
        continue;
      }
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0 && inTarget) return i;
    }
  }
  return -1;
}

/**
 * Merge the imported schema into an existing `.cyphra` source.
 *
 * Existing declarations, fields and comments are kept as written. Fields the existing nodes lack
 * are added at the end of their block; new nodes and relationships are appended. When a field or
 * relationship exists on both sides with a different definition, the existing one wins and an
 * issue says so.
 *
 * @returns The merged source and the extra issues the merge produced.
 * @throws When the existing source does not parse, or the merged schema does not resolve.
 */
export function mergeImportResult(
  existing: string,
  result: ImportResult,
  options: ImportPrintOptions,
): { source: string; issues: ImportIssue[] } {
  const doc: SchemaDocument = parseSchema(existing);
  const issues: ImportIssue[] = [];
  const kept = (at: string, what: string) =>
    issues.push({
      severity: "changed",
      at,
      feature: "--merge",
      message: `${what} already exists with a different definition: kept yours`,
    });
  let out = existing;
  const appended: Declaration[] = [];

  for (const decl of result.document.declarations) {
    const current = doc.declarations.find((d) => d.name === decl.name);
    if (!current) {
      appended.push(decl);
      continue;
    }
    if (decl.kind !== "Node" || current.kind !== "Node") {
      const same =
        decl.kind === current.kind &&
        printSchemaDocument({ kind: "Document", declarations: [decl] }) ===
          printSchemaDocument({ kind: "Document", declarations: [current] });
      if (!same) kept(decl.name, `${current.kind.toLowerCase()} ${decl.name}`);
      continue;
    }
    const missing: NodeField[] = [];
    for (const f of decl.fields) {
      const mine = (current as NodeDeclaration).fields.find((x) => x.name === f.name);
      if (!mine) missing.push(f);
      else if (formatField(mine) !== formatField(f))
        kept(`${decl.name}.${f.name}`, `field ${f.name}`);
    }
    // Full-text indexes the existing node lacks (matched by index name).
    const nameOf = (a: ModelAttribute) => a.args.find((x) => x.key === "name")?.value.value;
    const attrs: string[] = [];
    for (const a of decl.attributes ?? []) {
      const mine = (current as NodeDeclaration).attributes?.find(
        (x) => x.name === a.name && nameOf(x) === nameOf(a),
      );
      if (!mine) attrs.push(formatModelAttribute(a));
      else if (formatModelAttribute(mine) !== formatModelAttribute(a))
        kept(decl.name, `@@${a.name} ${String(nameOf(a))}`);
    }
    // Skip notes already in the file (importing the same source again).
    const notes = (result.notes.get(decl.name) ?? []).filter((n) => !out.includes(`// ${n}`));
    if (missing.length === 0 && notes.length === 0 && attrs.length === 0) continue;
    const close = nodeCloseBrace(out, decl.name);
    if (close < 0) throw new Error(`Could not find the block of node "${decl.name}".`);
    const lineStart = out.lastIndexOf("\n", close - 1) + 1;
    const onOwnLine = out.slice(lineStart, close).trim() === "";
    const added = [...missing.map(formatField), ...attrs, ...notes.map((n) => `// ${n}`)]
      .map((l) => `  ${l}\n`)
      .join("");
    out = onOwnLine
      ? out.slice(0, lineStart) + added + out.slice(lineStart)
      : `${out.slice(0, close).trimEnd()}\n${added}${out.slice(close)}`;
  }

  if (appended.length) {
    out = `${out.trimEnd()}\n\n${options.header}\n\n${printDeclarations(result, appended)}\n`;
  }
  try {
    resolveSchema(parseSchema(out));
  } catch (cause) {
    throw new Error(
      `Merging the imported models into the existing schema produced an invalid schema: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      { cause },
    );
  }
  return { source: out, issues };
}

/** Options of {@link formatImportIssues}. */
export type ImportReportOptions = {
  /** Title of the `ignored` section (default `"Ignored"`). */
  readonly ignoredTitle?: string;
};

/**
 * The import report as plain text, grouped by severity. Empty string when there is nothing to
 * report.
 */
export function formatImportIssues(
  issues: readonly ImportIssue[],
  options: ImportReportOptions = {},
): string {
  const sections: readonly { severity: ImportSeverity; title: string }[] = [
    { severity: "unsupported", title: "Not converted" },
    { severity: "changed", title: "Converted with differences" },
    { severity: "ignored", title: options.ignoredTitle ?? "Ignored" },
  ];
  const blocks: string[] = [];
  for (const s of sections) {
    const items = issues.filter((i) => i.severity === s.severity);
    if (items.length === 0) continue;
    const width = Math.min(32, Math.max(...items.map((i) => i.at.length)));
    blocks.push(
      [
        `${s.title} (${items.length}):`,
        ...items.map((i) => `  ${i.at.padEnd(width)}  ${i.feature}: ${i.message}`),
      ].join("\n"),
    );
  }
  return blocks.join("\n\n");
}
