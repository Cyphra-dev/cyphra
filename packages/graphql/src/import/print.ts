/**
 * Print a {@link GraphQLImportResult} as `.cyphra` source, merge it into an existing schema, and
 * format the import report.
 *
 * @packageDocumentation
 */

import {
  parseSchema,
  printSchemaDocument,
  resolveSchema,
  type Declaration,
  type NodeDeclaration,
  type NodeField,
  type SchemaDocument,
} from "@cyphra/schema";
import type { GraphQLImportResult } from "./convert.js";
import type { ImportIssue, ImportSeverity } from "./mappings.js";

const HEADER = "// Imported from @neo4j/graphql type definitions with `cyphra import graphql`.";

/** One declaration as `.cyphra` text, with `// …` notes for fields that were not converted. */
function printDeclaration(decl: Declaration, notes: readonly string[] | undefined): string {
  const text = printSchemaDocument({ kind: "Document", declarations: [decl] }).trimEnd();
  if (!notes?.length) return text;
  const lines = text.split("\n");
  lines.splice(lines.length - 1, 0, ...notes.map((n) => `  // ${n}`));
  return lines.join("\n");
}

function printDeclarations(result: GraphQLImportResult, decls: readonly Declaration[]): string {
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
 * The imported schema as a new `.cyphra` file.
 *
 * @param result - Output of {@link convertGraphQLTypeDefs}.
 */
export function printImportedSchema(result: GraphQLImportResult): string {
  const head = [HEADER, ...reviewComment(result.issues)].join("\n");
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
export function mergeImportedSchema(
  existing: string,
  result: GraphQLImportResult,
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
      if (!same)
        kept(decl.name, `${current.kind === "Node" ? "node" : "relationship"} ${decl.name}`);
      continue;
    }
    const missing: NodeField[] = [];
    for (const f of decl.fields) {
      const mine = (current as NodeDeclaration).fields.find((x) => x.name === f.name);
      if (!mine) missing.push(f);
      else if (formatField(mine) !== formatField(f))
        kept(`${decl.name}.${f.name}`, `field ${f.name}`);
    }
    // Skip notes already in the file (importing the same type definitions again).
    const notes = (result.notes.get(decl.name) ?? []).filter((n) => !out.includes(`// ${n}`));
    if (missing.length === 0 && notes.length === 0) continue;
    const close = nodeCloseBrace(out, decl.name);
    if (close < 0) throw new Error(`Could not find the block of node "${decl.name}".`);
    const lineStart = out.lastIndexOf("\n", close - 1) + 1;
    const onOwnLine = out.slice(lineStart, close).trim() === "";
    const added = [...missing.map(formatField), ...notes.map((n) => `// ${n}`)]
      .map((l) => `  ${l}\n`)
      .join("");
    out = onOwnLine
      ? out.slice(0, lineStart) + added + out.slice(lineStart)
      : `${out.slice(0, close).trimEnd()}\n${added}${out.slice(close)}`;
  }

  if (appended.length) {
    out = `${out.trimEnd()}\n\n${HEADER}\n\n${printDeclarations(result, appended)}\n`;
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

const SECTIONS: readonly { severity: ImportSeverity; title: string }[] = [
  { severity: "unsupported", title: "Not converted" },
  { severity: "changed", title: "Converted with differences" },
  { severity: "ignored", title: "Ignored (GraphQL API only)" },
];

/**
 * The import report as plain text, grouped by severity. Empty string when there is nothing to
 * report.
 */
export function formatImportReport(issues: readonly ImportIssue[]): string {
  const blocks: string[] = [];
  for (const s of SECTIONS) {
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
