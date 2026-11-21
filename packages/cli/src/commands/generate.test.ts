import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig, type CyphraConfig } from "../config.js";
import type { WatchFn } from "../watch.js";
import { runGenerate, runGenerateWatch, withZodFlags } from "./generate.js";

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

  it("regenerates the zod schemas too when the zod generator is configured", async () => {
    let emit!: (filename: string) => void;
    const watch: WatchFn = (_d, l) => {
      emit = (f) => l("change", f);
      return { close: () => undefined, on: () => undefined };
    };
    let stop!: () => void;
    const until = new Promise<void>((r) => (stop = r));
    const zodPath = path.join(dir, "src", "cyphra.zod.ts");
    const zodConfig = {
      ...config,
      zod: { output: zodPath, coerce: false, import: "zod", omitGenerated: false },
    };
    const zod = () => readFile(zodPath, "utf8");

    await writeFile(config.schema, "node User { id String @id }\n");
    const done = runGenerateWatch(dir, zodConfig, { until, watch, debounceMs: 5 });
    await vi.waitFor(async () => expect(await zod()).toMatch(/UserCreateInputSchema/));
    await writeFile(config.schema, "node Account { id String @id }\n");
    emit("schema.cyphra");
    await vi.waitFor(async () => expect(await zod()).toMatch(/AccountCreateInputSchema/));
    stop();
    await done;
    expect(console.log).toHaveBeenCalledWith(
      expect.stringMatching(/Wrote cyphra\.gen\.ts and src[/\\]cyphra\.zod\.ts$/),
    );
  });
});

describe("zod generator config", () => {
  let dir: string;
  const write = (data: unknown) => writeFile(path.join(dir, "cyphra.json"), JSON.stringify(data));
  const base = { schema: "./schema.cyphra", migrations: "./migrations" };
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "cyphra-genzod-"));
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  it("reads generators.zod from cyphra.json", async () => {
    await write(base);
    expect((await loadConfig(dir)).zod).toBeUndefined();
    await write({ ...base, generators: { zod: true } });
    expect((await loadConfig(dir)).zod).toEqual({
      output: path.join(dir, "cyphra.zod.ts"),
      coerce: false,
      import: "zod",
      omitGenerated: false,
    });
    await write({
      ...base,
      generators: { zod: { output: "src/db/zod.ts", coerce: true, import: "zod/v4" } },
    });
    expect((await loadConfig(dir)).zod).toEqual({
      output: path.join(dir, "src", "db", "zod.ts"),
      coerce: true,
      import: "zod/v4",
      omitGenerated: false,
    });
  });

  it.each([
    [{ zod: "yes" }, /"generators.zod" must be true or an object/],
    [{ zod: { output: 1 } }, /"generators.zod.output"/],
    [{ zod: { coerce: "yes" } }, /"generators.zod.coerce"/],
    [{ zod: { import: "" } }, /"generators.zod.import"/],
    [{ zod: { omitGenerated: "yes" } }, /"generators.zod.omitGenerated"/],
    [{ zod: { ouput: "x.ts" } }, /unknown option "ouput"/],
    [{ zod: { output: "../x.ts" } }, /escapes project root/],
  ])("rejects %j", async (generators, message) => {
    await write({ ...base, generators });
    await expect(loadConfig(dir)).rejects.toThrow(message);
  });

  it("--zod and --zod-coerce turn the generator on or override cyphra.json", async () => {
    await write(base);
    const config = await loadConfig(dir);
    expect(withZodFlags(dir, config, {})).toBe(config);
    expect(withZodFlags(dir, config, { zod: true }).zod).toEqual({
      output: path.join(dir, "cyphra.zod.ts"),
      coerce: false,
      import: "zod",
      omitGenerated: false,
    });
    expect(withZodFlags(dir, config, { zod: "lib/z.ts", zodCoerce: true }).zod).toEqual({
      output: path.join(dir, "lib", "z.ts"),
      coerce: true,
      import: "zod",
      omitGenerated: false,
    });
    await write({ ...base, generators: { zod: { output: "src/z.ts", import: "zod/v4" } } });
    const configured = await loadConfig(dir);
    expect(withZodFlags(dir, configured, { zodCoerce: true }).zod).toEqual({
      output: path.join(dir, "src", "z.ts"),
      coerce: true,
      import: "zod/v4",
      omitGenerated: false,
    });
  });

  it("--zod-omit-generated and generators.zod.omitGenerated leave generated fields out", async () => {
    await write({ ...base, generators: { zod: { omitGenerated: true } } });
    expect((await loadConfig(dir)).zod?.omitGenerated).toBe(true);
    await write(base);
    const config = await loadConfig(dir);
    expect(withZodFlags(dir, config, { zodOmitGenerated: true }).zod).toEqual({
      output: path.join(dir, "cyphra.zod.ts"),
      coerce: false,
      import: "zod",
      omitGenerated: true,
    });
    await writeFile(
      path.join(dir, "schema.cyphra"),
      "node User {\n id String @id @default(uuid())\n name String\n at DateTime @default(now())\n}\n",
    );
    await runGenerate(dir, withZodFlags(dir, config, { zodOmitGenerated: true }));
    const zod = await readFile(path.join(dir, "cyphra.zod.ts"), "utf8");
    expect(zod).toContain("UserCreateInputSchema = z.object({\n  name: UserFields.name,\n});");
    expect(zod).toContain(
      "UserUpdateInputSchema = z.object({\n  name: UserFields.name.optional(),\n});",
    );
  });

  it("runGenerate writes the client and the zod schemas", async () => {
    await write({ ...base, generators: { zod: { output: "src/cyphra.zod.ts", coerce: true } } });
    await writeFile(path.join(dir, "schema.cyphra"), "node User { id String @id\n at DateTime }\n");
    await runGenerate(dir, await loadConfig(dir));
    const zod = await readFile(path.join(dir, "src", "cyphra.zod.ts"), "utf8");
    expect(zod).toContain('import { z } from "zod";');
    expect(zod).toContain("at: z.preprocess(cyphraToDate, z.date()),");
    expect(await readFile(path.join(dir, "cyphra.gen.ts"), "utf8")).toMatch(/createClient/);
  });
});
