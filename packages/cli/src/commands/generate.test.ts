import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CyphraConfig } from "../config.js";
import type { WatchFn } from "../watch.js";
import { runGenerateWatch } from "./generate.js";

describe("runGenerateWatch", () => {
  let dir: string;
  let config: CyphraConfig;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "cyphra-genwatch-"));
    config = {
      schema: path.join(dir, "schema.cyphra"),
      migrations: path.join(dir, "migrations"),
      generate: path.join(dir, "cyphra.gen.ts"),
      runtimeImport: "cyphra",
    };
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  it("generates, prints schema errors without exiting, then regenerates once fixed", async () => {
    let emit!: (filename: string) => void;
    let closed = false;
    const watch: WatchFn = (_d, l) => {
      emit = (f) => l("change", f);
      return { close: () => void (closed = true), on: () => undefined };
    };
    let stop!: () => void;
    const until = new Promise<void>((r) => (stop = r));
    const gen = () => readFile(config.generate, "utf8");

    await writeFile(config.schema, "node User { id String @id }\n");
    const done = runGenerateWatch(dir, config, { until, watch, debounceMs: 5 });
    await vi.waitFor(async () => expect(await gen()).toMatch(/User/));

    await writeFile(config.schema, "node User { id Strin @id }\n");
    emit("schema.cyphra");
    await vi.waitFor(() =>
      expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/schema\.cyphra: /)),
    );
    expect(await gen()).toMatch(/User/);

    await writeFile(config.schema, "node Account { id String @id }\n");
    emit("schema.cyphra");
    await vi.waitFor(async () => expect(await gen()).toMatch(/Account/));

    stop();
    await done;
    expect(closed).toBe(true);
    expect(console.log).toHaveBeenCalledWith("Stopped watching.");
  });
});
