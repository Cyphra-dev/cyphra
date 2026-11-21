import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseSchema, renderCyphraGenSource, validateSchema } from "@cyphra/schema";
import type { CyphraConfig } from "../config.js";
import { untilInterrupted, watchFile, type WatchFn } from "../watch.js";

function generateFrom(source: string, config: CyphraConfig): string {
  const doc = parseSchema(source);
  validateSchema(doc);
  return renderCyphraGenSource(doc, { runtimeImport: config.runtimeImport });
}

/**
 * Emit `cyphra.gen.ts` (or configured path) from the schema file.
 *
 * @param cwd - Project root.
 * @param config - Loaded config with absolute schema and output paths.
 */
export async function runGenerate(cwd: string, config: CyphraConfig): Promise<void> {
  const out = generateFrom(await readFile(config.schema, "utf8"), config);
  await writeFile(config.generate, out, "utf8");
  console.log(`Wrote ${path.relative(cwd, config.generate)}`);
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
 * `cyphra generate --watch`: generate once, then regenerate whenever the schema file changes.
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
  const outRel = path.relative(cwd, config.generate);
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
    let out: string;
    try {
      out = generateFrom(source, config);
    } catch (err) {
      console.error(`[${time()}] ${rel}: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    await writeFile(config.generate, out, "utf8");
    console.log(`[${time()}] Wrote ${outRel}`);
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
