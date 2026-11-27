/**
 * What `cyphra graphql migrate-operations`, `compare` and `migrate-rules` share: the v7 type
 * definitions and the native schema and config they translate between, the files to read (globs),
 * and the GraphQL documents in them (`.graphql` files, `gql` / `graphql` templates in TS and JS).
 */
import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { migrate, type GraphQLConfig } from "@cyphra/graphql";
import type { MigrationContext } from "@cyphra/graphql";
import { parseSchema, resolveSchema, validateSchema } from "@cyphra/schema";
import ts from "typescript";
import { importModule, pickExport } from "./graphqlPrint.js";

/** Options naming both APIs. */
export type MigrationSourceOptions = {
  /** v7 type definitions: `.graphql` files, or modules exporting `typeDefs` (a string). */
  readonly typedefs?: readonly string[];
  /** `schema.cyphra` of the native API (default: converted from the type definitions). */
  readonly schema?: string;
  /** The native API's config module (default: `graphql.config.ts` / `.mts` / `.js` / `.mjs` if present). */
  readonly config?: string;
  /** Export of the config module (default: `default`, else its only export). */
  readonly export?: string;
  /** For the conversion without `--schema`: `Type.field` to mark `@id`. */
  readonly idFields?: readonly string[];
  /** For the conversion without `--schema`: map interfaces even without their label on the nodes. */
  readonly addInterfaceLabels?: boolean;
};

const DEFAULT_CONFIGS = [
  "graphql.config.ts",
  "graphql.config.mts",
  "graphql.config.js",
  "graphql.config.mjs",
];

/** The v7 type definitions files, read (a module's `typeDefs` export for `.ts` / `.js`). */
export async function readTypeDefs(
  cwd: string,
  files: readonly string[],
): Promise<{ name: string; body: string }[]> {
  const out: { name: string; body: string }[] = [];
  for (const f of files) {
    const abs = path.resolve(cwd, f);
    const name = path.relative(cwd, abs) || f;
    if (/\.(m|c)?(t|j)sx?$/.test(abs)) {
      const mod = await importModule(abs);
      const typeDefs = mod.typeDefs ?? mod.default;
      const body = Array.isArray(typeDefs) ? typeDefs.join("\n") : typeDefs;
      if (typeof body !== "string") throw new Error(`${name} exports no typeDefs string.`);
      out.push({ name, body });
    } else {
      out.push({ name, body: await readFile(abs, "utf8") });
    }
  }
  return out;
}

/** Both APIs, from the command's options. */
export async function loadMigrationContext(
  cwd: string,
  opts: MigrationSourceOptions,
): Promise<{
  ctx: MigrationContext;
  configFile?: string;
  typeDefs: { name: string; body: string }[];
}> {
  if (!opts.typedefs?.length) {
    throw new Error("Give the v7 type definitions: --typedefs <files...>.");
  }
  const typeDefs = await readTypeDefs(cwd, opts.typedefs);
  let schema;
  if (opts.schema) {
    const doc = parseSchema(await readFile(path.resolve(cwd, opts.schema), "utf8"));
    validateSchema(doc);
    schema = resolveSchema(doc);
  }
  let config: GraphQLConfig | undefined;
  const configFile = opts.config
    ? path.resolve(cwd, opts.config)
    : DEFAULT_CONFIGS.map((f) => path.join(cwd, f)).find((f) => existsSync(f));
  if (configFile) {
    if (!existsSync(configFile)) throw new Error(`Cannot find ${opts.config}.`);
    config = pickExport(
      await importModule(configFile),
      path.relative(cwd, configFile),
      opts.export,
    );
  }
  const ctx = migrate.createMigrationContext({
    typeDefs,
    schema,
    config,
    importOptions: {
      ...(opts.idFields?.length
        ? { idFields: opts.idFields.flatMap((x) => x.split(",")).filter(Boolean) }
        : {}),
      ...(opts.addInterfaceLabels ? { addInterfaceLabels: true } : {}),
    },
  });
  return { ctx, configFile: configFile ? path.relative(cwd, configFile) : undefined, typeDefs };
}

const SKIPPED_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "coverage"]);

/** `src/**\/*.{graphql,ts}` → a regular expression on `/`-separated relative paths. */
function globRegExp(pattern: string): RegExp {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === "*" && pattern[i + 1] === "*") {
      re += pattern[i + 2] === "/" ? "(?:.*/)?" : ".*";
      i += pattern[i + 2] === "/" ? 2 : 1;
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else if (c === "{") {
      const end = pattern.indexOf("}", i);
      re += `(?:${pattern
        .slice(i + 1, end)
        .split(",")
        .map((s) => s.replace(/[.+^$()|[\]\\]/g, "\\$&"))
        .join("|")})`;
      i = end;
    } else re += c.replace(/[.+^$()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!SKIPPED_DIRS.has(e.name)) out.push(...(await walk(path.join(dir, e.name))));
    } else if (e.isFile()) out.push(path.join(dir, e.name));
  }
  return out;
}

/** Document file extensions. */
const DOCUMENT_FILE = /\.(graphql|gql|[mc]?[jt]sx?)$/;

/**
 * The files matching `patterns` (globs with `*`, `**`, `?` and `{a,b}`; a directory means every
 * `.graphql` / `.gql` / TS / JS file under it), sorted. `node_modules`, `.git` and build output
 * are skipped.
 */
export async function expandFiles(cwd: string, patterns: readonly string[]): Promise<string[]> {
  const found = new Set<string>();
  for (const p of patterns) {
    const abs = path.resolve(cwd, p);
    if (!/[*?{]/.test(p)) {
      if (!existsSync(abs)) throw new Error(`Cannot find ${p}.`);
      if ((await stat(abs)).isDirectory()) {
        for (const f of await walk(abs)) if (DOCUMENT_FILE.test(f)) found.add(f);
      } else found.add(abs);
      continue;
    }
    const firstGlob = p.search(/[*?{]/);
    const base = path.resolve(cwd, p.slice(0, p.lastIndexOf("/", firstGlob) + 1) || ".");
    const re = globRegExp(path.relative(base, abs).split(path.sep).join("/"));
    if (!existsSync(base)) continue;
    for (const f of await walk(base)) {
      if (re.test(path.relative(base, f).split(path.sep).join("/"))) found.add(f);
    }
  }
  return [...found].sort();
}

/** One GraphQL document in a file. */
export type FileDocument = {
  /** Offset of the document's text in the file. */
  readonly start: number;
  readonly end: number;
  readonly text: string;
  /** Set when the document cannot be read (a template with `${…}`). */
  readonly skipped?: string;
};

const DEFAULT_TAGS = ["gql", "graphql"];

/** The callee or tag name: `gql`, `graphql`, `apollo.gql` → `gql`. */
function calleeName(e: ts.Expression): string | undefined {
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  return undefined;
}

/**
 * The GraphQL documents of a file: the whole of a `.graphql` / `.gql` file; in TS and JS, the
 * templates tagged `gql` / `graphql` (and `tags`), the templates passed to a call of one of
 * `tags` (`doc<T>(\`…\`)`), and templates after a `/* GraphQL *\/` comment.
 */
export function extractDocuments(
  file: string,
  text: string,
  tags: readonly string[] = [],
): FileDocument[] {
  if (/\.(graphql|gql)$/.test(file)) return [{ start: 0, end: text.length, text }];
  const names = new Set([...DEFAULT_TAGS, ...tags]);
  const callNames = new Set(tags);
  const kind = /\.[mc]?tsx$|\.jsx$/.test(file)
    ? ts.ScriptKind.TSX
    : /\.[mc]?ts$/.test(file)
      ? ts.ScriptKind.TS
      : ts.ScriptKind.JS;
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  const out: FileDocument[] = [];
  const take = (t: ts.TemplateLiteral) => {
    const start = t.getStart(sf) + 1;
    if (ts.isNoSubstitutionTemplateLiteral(t)) {
      out.push({ start, end: t.getEnd() - 1, text: text.slice(start, t.getEnd() - 1) });
    } else {
      out.push({
        start,
        end: t.getEnd() - 1,
        text: text.slice(start, t.getEnd() - 1),
        skipped:
          "the template has ${…} substitutions (inline the fragments, or migrate it by hand)",
      });
    }
  };
  const visit = (node: ts.Node) => {
    if (ts.isTaggedTemplateExpression(node)) {
      const name = calleeName(node.tag);
      if (name && names.has(name)) {
        take(node.template);
        return;
      }
    }
    if (ts.isCallExpression(node)) {
      const name = calleeName(node.expression);
      const first = node.arguments[0];
      if (name && callNames.has(name) && first && ts.isTemplateLiteral(first)) {
        take(first);
        return;
      }
    }
    if (ts.isTemplateLiteral(node) && !ts.isTaggedTemplateExpression(node.parent)) {
      const comments = ts.getLeadingCommentRanges(text, node.getFullStart()) ?? [];
      if (comments.some((c) => /^\/\*\s*GraphQL\s*\*\/$/.test(text.slice(c.pos, c.end)))) {
        take(node);
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** `file:line:column` of an offset in a file. */
export function locate(file: string, text: string, offset: number): string {
  const { line, column } = migrate.position(text, offset);
  return `${file}:${line}:${column}`;
}
