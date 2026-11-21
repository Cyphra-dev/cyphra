/**
 * A parser for Prisma schema files (`schema.prisma`), enough to import the data model: `model`,
 * `view`, `type` and `enum` blocks with their fields and attributes, and the key-value blocks
 * (`datasource`, `generator`). It follows the Prisma Schema Language grammar (PSL, Prisma 5 and 6):
 * one field per line, `//` and `///` comments, attributes with positional and named arguments,
 * function calls (`now()`, `dbgenerated("…")`), arrays and native types (`@db.VarChar(200)`).
 *
 * No dependency: `@prisma/prisma-schema-wasm` is a 4 MB engine build that also validates against a
 * datasource, and `@mrleebo/prisma-ast` pulls in a parser generator; the importer needs neither
 * (Prisma itself validates the file the user already has).
 *
 * @packageDocumentation
 */

/** A value in an attribute argument or a key-value block. */
export type PrismaValue =
  | { readonly kind: "string"; readonly value: string }
  | { readonly kind: "number"; readonly value: string }
  | { readonly kind: "boolean"; readonly value: boolean }
  /** An identifier (`Cascade`, `USER`), or a function call (`now()`) when `args` is set. */
  | { readonly kind: "ident"; readonly name: string; readonly args?: readonly PrismaArg[] }
  | { readonly kind: "array"; readonly items: readonly PrismaValue[] };

/** A positional (no `name`) or named attribute argument. */
export type PrismaArg = { readonly name?: string; readonly value: PrismaValue };

/** `@id`, `@db.VarChar(200)` (name `db.VarChar`), `@@unique([a, b])` (name `unique`). */
export type PrismaAttribute = {
  readonly name: string;
  readonly args: readonly PrismaArg[];
  readonly line: number;
};

export type PrismaField = {
  readonly name: string;
  /** Type name (`String`, a model or enum name); `Unsupported` for `Unsupported("…")`. */
  readonly type: string;
  readonly optional: boolean;
  readonly list: boolean;
  /** The text of `Unsupported("…")`. */
  readonly unsupported?: string;
  readonly attributes: readonly PrismaAttribute[];
  readonly line: number;
};

export type PrismaModel = {
  readonly kind: "model" | "view" | "type";
  readonly name: string;
  readonly fields: readonly PrismaField[];
  /** Block attributes (`@@id`, `@@unique`, `@@map`, …). */
  readonly attributes: readonly PrismaAttribute[];
  readonly line: number;
};

export type PrismaEnum = {
  readonly kind: "enum";
  readonly name: string;
  readonly values: readonly {
    readonly name: string;
    readonly attributes: readonly PrismaAttribute[];
  }[];
  readonly attributes: readonly PrismaAttribute[];
  readonly line: number;
};

/** `datasource db { … }` or `generator client { … }`. */
export type PrismaConfigBlock = {
  readonly kind: "datasource" | "generator";
  readonly name: string;
  readonly entries: ReadonlyMap<string, PrismaValue>;
  readonly line: number;
};

export type PrismaBlock = PrismaModel | PrismaEnum | PrismaConfigBlock;

export type PrismaSchema = { readonly blocks: readonly PrismaBlock[] };

/** The file is not a valid Prisma schema (as far as the importer can tell). */
export class PrismaImportError extends Error {
  override name = "PrismaImportError";
}

type TokenKind =
  | "ident"
  | "string"
  | "number"
  | "newline"
  | "@"
  | "@@"
  | "{"
  | "}"
  | "("
  | ")"
  | "["
  | "]"
  | ","
  | ":"
  | "="
  | "?"
  | "."
  | "eof";

type Token = { kind: TokenKind; text: string; line: number; column: number };

function tokenize(source: string, file: string): Token[] {
  const tokens: Token[] = [];
  let line = 1;
  let col = 1;
  let i = 0;
  const fail = (msg: string): never => {
    throw new PrismaImportError(`${file}:${line}:${col}: ${msg}`);
  };
  const advance = (n: number) => {
    i += n;
    col += n;
  };
  while (i < source.length) {
    const c = source[i]!;
    if (c === "\n") {
      tokens.push({ kind: "newline", text: "\n", line, column: col });
      i++;
      line++;
      col = 1;
      continue;
    }
    if (c === " " || c === "\t" || c === "\r" || c === "﻿") {
      advance(1);
      continue;
    }
    if (c === "/" && source[i + 1] === "/") {
      while (i < source.length && source[i] !== "\n") advance(1);
      continue;
    }
    if (c === "/" && source[i + 1] === "*") {
      advance(2);
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) {
        if (source[i] === "\n") {
          i++;
          line++;
          col = 1;
        } else advance(1);
      }
      if (i >= source.length) fail("unterminated comment");
      advance(2);
      continue;
    }
    const start = { line, column: col };
    if (c === '"') {
      let value = "";
      advance(1);
      for (;;) {
        const ch = source[i];
        if (ch === undefined || ch === "\n") fail("unterminated string");
        if (ch === '"') break;
        if (ch === "\\") {
          const next = source[i + 1];
          const map: Record<string, string> = { n: "\n", t: "\t", r: "\r", '"': '"', "\\": "\\" };
          if (next === "u" && /^[0-9a-fA-F]{4}$/.test(source.slice(i + 2, i + 6))) {
            value += String.fromCharCode(parseInt(source.slice(i + 2, i + 6), 16));
            advance(6);
            continue;
          }
          value += next !== undefined && map[next] !== undefined ? map[next] : (next ?? "");
          advance(2);
          continue;
        }
        value += ch;
        advance(1);
      }
      advance(1);
      tokens.push({ kind: "string", text: value, ...start });
      continue;
    }
    const num = /^-?[0-9]+(\.[0-9]+)?([eE][+-]?[0-9]+)?/.exec(source.slice(i));
    if (num && (c !== "-" || /[0-9]/.test(source[i + 1] ?? ""))) {
      tokens.push({ kind: "number", text: num[0], ...start });
      advance(num[0].length);
      continue;
    }
    const id = /^[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(i));
    if (id) {
      tokens.push({ kind: "ident", text: id[0], ...start });
      advance(id[0].length);
      continue;
    }
    if (c === "@" && source[i + 1] === "@") {
      tokens.push({ kind: "@@", text: "@@", ...start });
      advance(2);
      continue;
    }
    if ("@{}()[],:=?.".includes(c)) {
      tokens.push({ kind: c as TokenKind, text: c, ...start });
      advance(1);
      continue;
    }
    fail(`unexpected character ${JSON.stringify(c)}`);
  }
  tokens.push({ kind: "eof", text: "", line, column: col });
  return tokens;
}

class Parser {
  private pos = 0;
  constructor(
    private readonly tokens: Token[],
    private readonly file: string,
  ) {}

  private peek(offset = 0): Token {
    return this.tokens[Math.min(this.pos + offset, this.tokens.length - 1)]!;
  }

  private next(): Token {
    const t = this.peek();
    if (t.kind !== "eof") this.pos++;
    return t;
  }

  private fail(t: Token, msg: string): never {
    throw new PrismaImportError(`${this.file}:${t.line}:${t.column}: ${msg}`);
  }

  private expect(kind: TokenKind, what?: string): Token {
    const t = this.next();
    if (t.kind !== kind) {
      this.fail(
        t,
        `expected ${what ?? kind}, found ${t.kind === "eof" ? "end of file" : JSON.stringify(t.text)}`,
      );
    }
    return t;
  }

  private skipNewlines(): void {
    while (this.peek().kind === "newline") this.pos++;
  }

  parse(): PrismaSchema {
    const blocks: PrismaBlock[] = [];
    for (;;) {
      this.skipNewlines();
      const t = this.peek();
      if (t.kind === "eof") break;
      const kw = this.expect("ident", "a block (model, enum, datasource, generator, view, type)");
      switch (kw.text) {
        case "model":
        case "view":
        case "type":
          blocks.push(this.model(kw.text, kw.line));
          break;
        case "enum":
          blocks.push(this.enumBlock(kw.line));
          break;
        case "datasource":
        case "generator":
          blocks.push(this.configBlock(kw.text, kw.line));
          break;
        default:
          this.fail(kw, `unknown block "${kw.text}"`);
      }
    }
    return { blocks };
  }

  private model(kind: "model" | "view" | "type", line: number): PrismaModel {
    const name = this.expect("ident", "a name").text;
    this.expect("{");
    const fields: PrismaField[] = [];
    const attributes: PrismaAttribute[] = [];
    for (;;) {
      this.skipNewlines();
      const t = this.peek();
      if (t.kind === "}") {
        this.next();
        break;
      }
      if (t.kind === "@@") {
        attributes.push(this.attribute("@@"));
        this.endOfLine();
        continue;
      }
      fields.push(this.field());
    }
    return { kind, name, fields, attributes, line };
  }

  private field(): PrismaField {
    const nameTok = this.expect("ident", "a field name");
    const typeTok = this.expect("ident", "a field type");
    let unsupported: string | undefined;
    if (typeTok.text === "Unsupported" && this.peek().kind === "(") {
      this.next();
      unsupported = this.expect("string", "a string").text;
      this.expect(")");
    }
    let list = false;
    let optional = false;
    if (this.peek().kind === "[") {
      this.next();
      this.expect("]");
      list = true;
    }
    if (this.peek().kind === "?") {
      this.next();
      optional = true;
    }
    const attributes: PrismaAttribute[] = [];
    while (this.peek().kind === "@") attributes.push(this.attribute("@"));
    this.endOfLine();
    return {
      name: nameTok.text,
      type: typeTok.text,
      optional,
      list,
      ...(unsupported !== undefined ? { unsupported } : {}),
      attributes,
      line: nameTok.line,
    };
  }

  private endOfLine(): void {
    const t = this.peek();
    if (t.kind === "newline" || t.kind === "}" || t.kind === "eof") return;
    this.fail(t, `unexpected ${JSON.stringify(t.text)}`);
  }

  private attribute(prefix: "@" | "@@"): PrismaAttribute {
    const at = this.expect(prefix);
    let name = this.expect("ident", "an attribute name").text;
    while (this.peek().kind === ".") {
      this.next();
      name += `.${this.expect("ident", "an attribute name").text}`;
    }
    const args = this.peek().kind === "(" ? this.args() : [];
    return { name, args, line: at.line };
  }

  private args(): PrismaArg[] {
    this.expect("(");
    const args: PrismaArg[] = [];
    this.skipNewlines();
    while (this.peek().kind !== ")") {
      if (this.peek().kind === "ident" && this.peek(1).kind === ":") {
        const name = this.next().text;
        this.next();
        this.skipNewlines();
        args.push({ name, value: this.value() });
      } else {
        args.push({ value: this.value() });
      }
      this.skipNewlines();
      if (this.peek().kind === ",") {
        this.next();
        this.skipNewlines();
      } else break;
    }
    this.skipNewlines();
    this.expect(")");
    return args;
  }

  private value(): PrismaValue {
    const t = this.next();
    switch (t.kind) {
      case "string":
        return { kind: "string", value: t.text };
      case "number":
        return { kind: "number", value: t.text };
      case "ident": {
        if (t.text === "true" || t.text === "false")
          return { kind: "boolean", value: t.text === "true" };
        let name = t.text;
        while (this.peek().kind === "." && this.peek(1).kind === "ident") {
          this.next();
          name += `.${this.next().text}`;
        }
        if (this.peek().kind === "(") return { kind: "ident", name, args: this.args() };
        return { kind: "ident", name };
      }
      case "[": {
        const items: PrismaValue[] = [];
        this.skipNewlines();
        while (this.peek().kind !== "]") {
          items.push(this.value());
          this.skipNewlines();
          if (this.peek().kind === ",") {
            this.next();
            this.skipNewlines();
          } else break;
        }
        this.expect("]");
        return { kind: "array", items };
      }
      default:
        return this.fail(t, `expected a value, found ${JSON.stringify(t.text)}`);
    }
  }

  private enumBlock(line: number): PrismaEnum {
    const name = this.expect("ident", "a name").text;
    this.expect("{");
    const values: { name: string; attributes: PrismaAttribute[] }[] = [];
    const attributes: PrismaAttribute[] = [];
    for (;;) {
      this.skipNewlines();
      const t = this.peek();
      if (t.kind === "}") {
        this.next();
        break;
      }
      if (t.kind === "@@") {
        attributes.push(this.attribute("@@"));
        this.endOfLine();
        continue;
      }
      const v = this.expect("ident", "an enum value").text;
      const attrs: PrismaAttribute[] = [];
      while (this.peek().kind === "@") attrs.push(this.attribute("@"));
      this.endOfLine();
      values.push({ name: v, attributes: attrs });
    }
    return { kind: "enum", name, values, attributes, line };
  }

  private configBlock(kind: "datasource" | "generator", line: number): PrismaConfigBlock {
    const name = this.expect("ident", "a name").text;
    this.expect("{");
    const entries = new Map<string, PrismaValue>();
    for (;;) {
      this.skipNewlines();
      if (this.peek().kind === "}") {
        this.next();
        break;
      }
      const key = this.expect("ident", "a key").text;
      this.expect("=");
      entries.set(key, this.value());
      this.endOfLine();
    }
    return { kind, name, entries, line };
  }
}

/**
 * Parse a Prisma schema.
 *
 * @param source - The `schema.prisma` text.
 * @param file - Name used in error messages.
 * @throws {PrismaImportError} On a syntax error.
 */
export function parsePrismaSchema(source: string, file = "schema.prisma"): PrismaSchema {
  return new Parser(tokenize(source, file), file).parse();
}

/** The value of a named argument, or of the positional argument at `index`. */
export function prismaArg(
  attr: PrismaAttribute,
  name: string,
  index?: number,
): PrismaValue | undefined {
  const named = attr.args.find((a) => a.name === name);
  if (named) return named.value;
  if (index === undefined) return undefined;
  return attr.args.filter((a) => a.name === undefined)[index]?.value;
}

/** Field names of a `[a, b(sort: Desc)]` list (the sort and length options are dropped). */
export function prismaFieldList(v: PrismaValue | undefined): string[] | undefined {
  if (!v) return undefined;
  const items = v.kind === "array" ? v.items : [v];
  const out: string[] = [];
  for (const i of items) {
    if (i.kind !== "ident") return undefined;
    out.push(i.name);
  }
  return out;
}
