/**
 * Writes the Better Auth nodes into an existing `schema.cyphra` without touching anything else.
 *
 * Fields of auth nodes that Better Auth defines are added or updated in place, line by line.
 * Everything else is kept as written, comments included: your own models, relationships, and
 * fields you added to auth nodes (for example `projects Project[]` on `User`).
 *
 * @packageDocumentation
 */

import {
  formatModelAttribute,
  parseSchema,
  printSchemaDocument,
  resolveSchema,
  type ModelAttribute,
  type NodeDeclaration,
  type NodeField,
  type SchemaDocument,
} from "@cyphra/schema";

const HEADER = `// Better Auth models, written by @cyphra/better-auth (npx @better-auth/cli generate).
// You can add fields and relations to these nodes and add your own models: running the
// generator again updates the Better Auth fields and keeps the rest.
`;

/** One field formatted as a `.cyphra` line (without indentation). */
function formatField(field: NodeField): string {
  const text = printSchemaDocument({
    kind: "Document",
    declarations: [{ kind: "Node", name: "X", fields: [field] }],
  });
  return text.split("\n")[1]!.trim();
}

/** Attributes of `auth` that `existing` does not have yet (compared as printed). */
function missingAttributes(existing: NodeDeclaration, auth: NodeDeclaration): ModelAttribute[] {
  const have = new Set((existing.attributes ?? []).map(formatModelAttribute));
  return (auth.attributes ?? []).filter((a) => !have.has(formatModelAttribute(a)));
}

function formatNode(node: NodeDeclaration): string {
  return printSchemaDocument({ kind: "Document", declarations: [node] }).trimEnd();
}

/** Index of the `//` that starts a comment on `line`, ignoring `//` inside strings. */
function commentStart(line: string): number {
  let inString = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "/" && line[i + 1] === "/") return i;
  }
  return -1;
}

type Block = { name: string; open: number; close: number };

/** Top-level `node Name { … }` blocks with the offsets of their braces. */
function nodeBlocks(source: string): Block[] {
  const blocks: Block[] = [];
  let depth = 0;
  let pending: { name: string } | null = null;
  let current: { name: string; open: number } | null = null;
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
        pending = m[1] === "node" ? { name: m[2]! } : null;
        i += m[0].length - 1;
        continue;
      }
    }
    if (c === "{") {
      if (depth === 0 && pending) current = { name: pending.name, open: i };
      pending = null;
      depth++;
    } else if (c === "}") {
      depth--;
      if (depth === 0 && current) {
        blocks.push({ ...current, close: i });
        current = null;
      }
    }
  }
  return blocks;
}

/**
 * Merge the fields of `auth` into the existing block of the same node, or return `null` when
 * the block's layout is unusual (several fields per line, …) and should be reprinted instead.
 */
function mergeBlock(
  source: string,
  block: Block,
  existing: NodeDeclaration,
  auth: NodeDeclaration,
): string | null {
  const body = source.slice(block.open + 1, block.close);
  const lines = body.split("\n");
  // The closing brace must sit on its own line so new fields can go right before it.
  if (lines.length < 2 || lines[lines.length - 1]!.trim() !== "") return null;
  const names: { line: number; name: string }[] = [];
  const attributeLines: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const cut = commentStart(line);
    const code = (cut >= 0 ? line.slice(0, cut) : line).trim();
    if (i === 0 && code !== "") return null; // a field on the `node X {` line
    if (!code) continue;
    if (code.startsWith("@@")) {
      // One attribute per line, closed on that line.
      if (!code.endsWith(")")) return null;
      attributeLines.push(i);
      continue;
    }
    const m = /^([A-Za-z_][A-Za-z0-9_]*)/.exec(code);
    if (!m) return null;
    names.push({ line: i, name: m[1]! });
  }
  if (
    names.length !== existing.fields.length ||
    names.some((n, i) => n.name !== existing.fields[i]!.name)
  ) {
    return null;
  }

  const firstLine = names[0] ? lines[names[0].line]! : "  ";
  const indent = /^\s*/.exec(firstLine)![0] || "  ";
  const added: string[] = [];
  for (const field of auth.fields) {
    const at = existing.fields.findIndex((f) => f.name === field.name);
    if (at < 0) {
      added.push(`${indent}${formatField(field)}`);
      continue;
    }
    if (formatField(existing.fields[at]!) === formatField(field)) continue;
    const lineNo = names[at]!.line;
    const line = lines[lineNo]!;
    const cut = commentStart(line);
    const comment = cut >= 0 ? ` ${line.slice(cut)}` : "";
    lines[lineNo] = `${/^\s*/.exec(line)![0]}${formatField(field)}${comment}`;
  }
  const newAttributes = missingAttributes(existing, auth).map(
    (a) => `${indent}${formatModelAttribute(a)}`,
  );
  if (attributeLines.length) {
    // New fields go after the last field (before the attributes), new attributes after the last one.
    const lastAttribute = attributeLines[attributeLines.length - 1]!;
    lines.splice(lastAttribute + 1, 0, ...newAttributes);
    const afterField = names.length ? names[names.length - 1]!.line + 1 : 1;
    if (afterField > lastAttribute) return null;
    lines.splice(afterField, 0, ...added);
  } else {
    lines.splice(
      lines.length - 1,
      0,
      ...added,
      ...(newAttributes.length ? ["", ...newAttributes] : []),
    );
  }
  return lines.join("\n");
}

/**
 * The `.cyphra` source with the Better Auth nodes of `authDoc` added or updated.
 *
 * @param existing - Current contents of `schema.cyphra`, or `undefined` if there is none.
 * @param authDoc - Auth nodes derived from the Better Auth configuration.
 * @throws When the existing file does not parse, or the merged schema does not resolve.
 */
export function mergeAuthSchema(existing: string | undefined, authDoc: SchemaDocument): string {
  if (existing === undefined || existing.trim() === "") {
    return `${HEADER}\n${printSchemaDocument(authDoc)}`;
  }
  const doc = parseSchema(existing);
  const blocks = nodeBlocks(existing);
  const edits: { start: number; end: number; text: string }[] = [];
  const appended: string[] = [];

  for (const decl of authDoc.declarations) {
    if (decl.kind !== "Node") continue;
    const current = doc.declarations.find(
      (d): d is NodeDeclaration => d.kind === "Node" && d.name === decl.name,
    );
    const block = blocks.find((b) => b.name === decl.name);
    if (!current || !block) {
      appended.push(formatNode(decl));
      continue;
    }
    const merged = mergeBlock(existing, block, current, decl);
    if (merged !== null) {
      edits.push({ start: block.open + 1, end: block.close, text: merged });
      continue;
    }
    // Unusual layout: reprint this node, keeping its non-auth fields after the auth ones.
    const extra = current.fields.filter((f) => !decl.fields.some((a) => a.name === f.name));
    const attributes = [...(current.attributes ?? []), ...missingAttributes(current, decl)];
    const node: NodeDeclaration = {
      ...decl,
      fields: [...decl.fields, ...extra],
      ...(attributes.length ? { attributes } : {}),
    };
    const start = existing.lastIndexOf("node", block.open);
    edits.push({ start, end: block.close + 1, text: formatNode(node) });
  }

  let out = existing;
  for (const e of edits.sort((a, b) => b.start - a.start)) {
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
  }
  if (appended.length) out = `${out.trimEnd()}\n\n${appended.join("\n\n")}\n`;

  try {
    resolveSchema(parseSchema(out));
  } catch (cause) {
    throw new Error(
      "@cyphra/better-auth: merging the Better Auth models into your schema produced an invalid schema. Check for fields on auth nodes that clash with Better Auth fields.",
      { cause },
    );
  }
  return out;
}
