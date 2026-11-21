import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig, type CyphraConfig } from "../config.js";
import { runDbSeed, runSeedCommand, seedEnv } from "./seed.js";

const node = JSON.stringify(process.execPath);

describe("seed", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "cyphra-seed-"));
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  const config = (seed?: string): CyphraConfig => ({
    schema: path.join(dir, "schema.cyphra"),
    migrations: path.join(dir, "migrations"),
    generate: path.join(dir, "cyphra.gen.ts"),
    runtimeImport: "cyphra",
    ...(seed ? { seed } : {}),
  });

  it("reads the seed command from cyphra.json and rejects non-strings", async () => {
    const write = (data: unknown) => writeFile(path.join(dir, "cyphra.json"), JSON.stringify(data));
    await write({ schema: "./s.cyphra", migrations: "./m", seed: "  tsx seed.ts " });
    expect((await loadConfig(dir)).seed).toBe("tsx seed.ts");
    await write({ schema: "./s.cyphra", migrations: "./m" });
    expect((await loadConfig(dir)).seed).toBeUndefined();
    await write({ schema: "./s.cyphra", migrations: "./m", seed: ["tsx", "seed.ts"] });
    await expect(loadConfig(dir)).rejects.toThrow(/"seed" must be a non-empty command string/);
    await write({ schema: "./s.cyphra", migrations: "./m", seed: "" });
    await expect(loadConfig(dir)).rejects.toThrow(/"seed"/);
  });

  it("puts the project's node_modules/.bin first on PATH and keeps the rest of the env", () => {
    const env = seedEnv("/proj", { PATH: "/usr/bin", NEO4J_URI: "bolt://localhost" });
    expect(env.PATH).toBe(`${path.join("/proj", "node_modules", ".bin")}${path.delimiter}/usr/bin`);
    expect(env.NEO4J_URI).toBe("bolt://localhost");
    // Windows-style key is kept, not duplicated.
    const win = seedEnv("/proj", { Path: "C:\\bin" });
    expect(Object.keys(win)).toEqual(["Path"]);
    expect(seedEnv("/proj", {}).PATH).toBe(path.join("/proj", "node_modules", ".bin"));
  });

  it("runs the command from the project root with the environment and propagates the exit code", async () => {
    await writeFile(
      path.join(dir, "seed.mjs"),
      `import { writeFileSync } from "node:fs";
writeFileSync("seeded.txt", process.env.CYPHRA_SEED_TEST ?? "");
process.exit(Number(process.env.CYPHRA_SEED_EXIT ?? 0));
`,
    );
    process.env.CYPHRA_SEED_TEST = "from-env";
    try {
      expect(await runSeedCommand(dir, `${node} seed.mjs`)).toBe(0);
      expect(await readFile(path.join(dir, "seeded.txt"), "utf8")).toBe("from-env");
      process.env.CYPHRA_SEED_EXIT = "3";
      expect(await runDbSeed(dir, config(`${node} seed.mjs`))).toBe(3);
    } finally {
      delete process.env.CYPHRA_SEED_TEST;
      delete process.env.CYPHRA_SEED_EXIT;
    }
  });

  it("fails with 1 when no seed is configured", async () => {
    expect(await runDbSeed(dir, config())).toBe(1);
    expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/No seed command configured/));
  });
});
