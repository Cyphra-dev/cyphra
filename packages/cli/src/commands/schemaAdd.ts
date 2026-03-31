import { readFile, writeFile } from "node:fs/promises";
import * as p from "@clack/prompts";
import { parseSchema, SchemaValidationError, validateSchema } from "@cyphra/schema";
import type { CyphraConfig } from "@cyphra/config";

type FieldInput = { name: string; type: string; optional: boolean; unique?: boolean };

const SCALAR_TYPES = new Set(["String", "Int", "Float", "Boolean", "DateTime"]);

export type SchemaAddJson = {
  readonly label: string;
  readonly fields: ReadonlyArray<{
    readonly name: string;
    readonly type: string;
    readonly optional?: boolean;
    /** When true, append `@id` (first @id wins if multiple). */
    readonly id?: boolean;
    readonly unique?: boolean;
  }>;
};

function isTTY(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

function renderNodeBlock(label: string, fields: FieldInput[], idFieldName: string | undefined): string {
  const bodyLines = fields.map((f) => {
    const opt = f.optional ? "?" : "";
    const decs: string[] = [];
    if (idFieldName === f.name) decs.push("@id");
    if (f.unique) decs.push("@unique");
    const dec = decs.length ? ` ${decs.join(" ")}` : "";
    return `  ${f.name} ${f.type}${opt}${dec}`;
  });
  return `\nnode ${label} {\n${bodyLines.join("\n")}\n}\n`;
}

async function appendNodeToSchema(config: CyphraConfig, block: string): Promise<void> {
  let existing = "";
  try {
    existing = await readFile(config.schema, "utf8");
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code !== "ENOENT") throw e;
  }

  const merged = `${existing.trimEnd()}\n${block}`;
  try {
    const doc = parseSchema(merged);
    validateSchema(doc);
  } catch (e) {
    if (e instanceof SchemaValidationError) {
      throw new Error(`Schema would be invalid: ${e.message}`);
    }
    throw e;
  }

  await writeFile(config.schema, merged.endsWith("\n") ? merged : `${merged}\n`, "utf8");
}

/**
 * Non-interactive: append a `node` from JSON (CI / scripts).
 */
export async function runSchemaAddFromJson(
  config: CyphraConfig,
  payload: SchemaAddJson,
): Promise<void> {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(payload.label)) {
    throw new Error(`Invalid label: ${JSON.stringify(payload.label)}`);
  }
  if (!payload.fields?.length) {
    throw new Error("schema add --json: fields array must be non-empty");
  }
  const fields: FieldInput[] = [];
  let idField: string | undefined;
  for (const f of payload.fields) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(f.name)) {
      throw new Error(`Invalid field name: ${JSON.stringify(f.name)}`);
    }
    if (!SCALAR_TYPES.has(f.type)) {
      throw new Error(`Unsupported type for field ${f.name}: ${JSON.stringify(f.type)}`);
    }
    fields.push({
      name: f.name,
      type: f.type,
      optional: Boolean(f.optional),
      unique: Boolean(f.unique),
    });
    if (f.id) {
      idField = idField ?? f.name;
    }
  }
  if (!idField) {
    throw new Error("schema add --json: mark one field with \"id\": true for @id");
  }
  const block = renderNodeBlock(payload.label, fields, idField);
  await appendNodeToSchema(config, block);
  process.stdout.write(`Updated ${config.schema}\n`);
}

/**
 * Interactive wizard: append a `node` block to the schema file (validates before write).
 */
export async function runSchemaAddInteractive(cwd: string, config: CyphraConfig): Promise<void> {
  void cwd;
  if (!isTTY()) {
    throw new Error(
      'Interactive mode requires a TTY. Pass --json <file> for non-interactive use, or edit schema.cyphra by hand.',
    );
  }

  p.intro("Cyphra — add node");

  const label = await p.text({
    message: "Neo4j label / node name (PascalCase)",
    placeholder: "Product",
    validate: (v) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(v ?? "") ? undefined : "Use letters, numbers, underscore"),
  });
  if (p.isCancel(label)) {
    p.cancel("Aborted");
    process.exit(0);
  }

  const fields: FieldInput[] = [];
  let addMore = true;
  while (addMore) {
    const name = await p.text({
      message: "Field name (empty to finish)",
      placeholder: "title",
    });
    if (p.isCancel(name)) {
      p.cancel("Aborted");
      process.exit(0);
    }
    if (!name?.trim()) {
      addMore = false;
      break;
    }
    const type = await p.select({
      message: `Type for "${name}"`,
      options: [
        { value: "String", label: "String" },
        { value: "Int", label: "Int" },
        { value: "Float", label: "Float" },
        { value: "Boolean", label: "Boolean" },
        { value: "DateTime", label: "DateTime" },
      ],
    });
    if (p.isCancel(type)) {
      p.cancel("Aborted");
      process.exit(0);
    }
    const optional = await p.confirm({ message: "Optional?", initialValue: false });
    if (p.isCancel(optional)) {
      p.cancel("Aborted");
      process.exit(0);
    }
    fields.push({ name: name.trim(), type: String(type), optional: Boolean(optional) });
  }

  if (fields.length === 0) {
    p.log.warn("No fields — add at least one scalar field or cancel.");
    p.outro("No changes.");
    return;
  }

  const idField = await p.confirm({
    message: `Mark "${fields[0]!.name}" as @id?`,
    initialValue: true,
  });
  if (p.isCancel(idField)) {
    p.cancel("Aborted");
    process.exit(0);
  }

  const block = renderNodeBlock(String(label), fields, idField ? fields[0]!.name : undefined);
  await appendNodeToSchema(config, block);
  p.outro(`Updated ${config.schema}`);
}
