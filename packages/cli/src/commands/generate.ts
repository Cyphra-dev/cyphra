import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  parseSchema,
  renderCyphraGenSource,
  renderZodSource,
  schemaWarnings,
  validateSchema,
} from "@cyphra/schema";
import { DEFAULT_ZOD_OUTPUT, type CyphraConfig } from "../config.js";
import { resolveUnderRoot } from "../paths.js";
import { untilInterrupted, watchFile, type WatchFn } from "../watch.js";
import { warningLines } from "./validateSchema.js";

/** A generated file: absolute path and content. */
type Output = { readonly path: string; readonly content: string };

/** Every file `cyphra generate` writes for `source`: the client, then the zod schemas if configured. */
function generateFrom(source: string, config: CyphraConfig, cwd?: string): Output[] {
  const doc = parseSchema(source, { locations: true });
  validateSchema(doc);
  if (cwd !== undefined) {
    for (const line of warningLines(path.relative(cwd, config.schema), schemaWarnings(doc))) {
      console.warn(line);
    }
  }
  const out: Output[] = [
    {
      path: config.generate,
      content: renderCyphraGenSource(doc, { runtimeImport: config.runtimeImport }),
    },
  ];
  if (config.zod) {
    out.push({
      path: config.zod.output,
      content: renderZodSource(doc, {
        coerce: config.zod.coerce,
        zodImport: config.zod.import,
        omitGenerated: config.zod.omitGenerated,
      }),
    });
  }
  return out;
}

async function writeOutputs(outputs: readonly Output[]): Promise<void> {
  for (const o of outputs) {
    await mkdir(path.dirname(o.path), { recursive: true });
    await writeFile(o.path, o.content, "utf8");
  }
}

function relList(cwd: string, outputs: readonly Output[]): string {
  return outputs.map((o) => path.relative(cwd, o.path)).join(" and ");
}

/** `cyphra generate` flags of the zod generator. */
export type ZodFlags = {
  /** `--zod` (`true`) or `--zod <output>`. */
  readonly zod?: string | boolean;
  /** `--zod-coerce`. */
  readonly zodCoerce?: boolean;
  /** `--zod-omit-generated`. */
  readonly zodOmitGenerated?: boolean;
};

/**
 * `config` with the zod generator flags applied: `--zod [output]` turns the generator on (and sets
 * its output), `--zod-coerce` turns it on with coercion, `--zod-omit-generated` turns it on and leaves
 * generated fields out of the input schemas. Other options come from `cyphra.json`.
 */
export function withZodFlags(cwd: string, config: CyphraConfig, flags: ZodFlags): CyphraConfig {
  if (!flags.zod && !flags.zodCoerce && !flags.zodOmitGenerated) return config;
  const output =
    typeof flags.zod === "string"
      ? resolveUnderRoot(cwd, flags.zod)
      : (config.zod?.output ?? resolveUnderRoot(cwd, DEFAULT_ZOD_OUTPUT));
  return {
    ...config,
    zod: {
      output,
      coerce: flags.zodCoerce ?? config.zod?.coerce ?? false,
      import: config.zod?.import ?? "zod",
      omitGenerated: flags.zodOmitGenerated || (config.zod?.omitGenerated ?? false),
    },
  };
}

/**
 * Emit `cyphra.gen.ts` (or configured path) from the schema file, and the zod schemas when the zod
 * generator is configured (`config.zod`).
 *
 * @param cwd - Project root.
 * @param config - Loaded config with absolute schema and output paths.
 */
export async function runGenerate(cwd: string, config: CyphraConfig): Promise<void> {
  const outputs = generateFrom(await readFile(config.schema, "utf8"), config, cwd);
  await writeOutputs(outputs);
  console.log(`Wrote ${relList(cwd, outputs)}`);
}

export type GenerateWatchOptions = {
  /** Resolves when watching should stop (default: Ctrl+C / SIGTERM). */
  readonly until?: Promise<void>;
  readonly debounceMs?: number;
  readonly watch?: WatchFn;
};

function time(): string {
  return new Date().toTimeString().slice(0, 8);
}

/**
 * `cyphra generate --watch`: generate once, then regenerate (the client and the zod schemas, when
 * configured) whenever the schema file changes.
 * Invalid schemas print their error and the watcher keeps going; an unchanged file is skipped.
 *
 * @param cwd - Project root.
 * @param config - Loaded config.
 * @param opts - Stop signal, debounce and injectable watcher (tests).
 */
export async function runGenerateWatch(
  cwd: string,
  config: CyphraConfig,
  opts: GenerateWatchOptions = {},
): Promise<void> {
  const rel = path.relative(cwd, config.schema);
  let last: string | undefined;

  const regenerate = async (): Promise<void> => {
    let source: string;
    try {
      source = await readFile(config.schema, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      // Mid-rename save, or the file was deleted: the next event retries.
      console.error(`[${time()}] ${rel} not found; waiting for it to come back.`);
      last = undefined;
      return;
    }
    if (source === last) return;
    last = source;
    let outputs: Output[];
    try {
      outputs = generateFrom(source, config, cwd);
    } catch (err) {
      console.error(`[${time()}] ${rel}: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    await writeOutputs(outputs);
    console.log(`[${time()}] Wrote ${relList(cwd, outputs)}`);
  };

  await regenerate();
  const handle = watchFile({
    file: config.schema,
    onChange: regenerate,
    debounceMs: opts.debounceMs,
    watch: opts.watch,
    onError: (err) => console.error(`[${time()}] ${err.message}`),
  });
  console.log(`Watching ${rel} for changes (Ctrl+C to stop).`);
  try {
    await (opts.until ?? untilInterrupted());
  } finally {
    handle.close();
  }
  console.log("Stopped watching.");
}
