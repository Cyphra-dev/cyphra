import { spawn } from "node:child_process";
import path from "node:path";
import type { CyphraConfig } from "../config.js";

/**
 * Environment for the seed command: the CLI's environment (including `./.env`, loaded at startup)
 * with `<project>/node_modules/.bin` first on `PATH`, so `"seed": "tsx seed.ts"` finds a locally
 * installed `tsx` even when `cyphra` was not started through a package manager.
 *
 * @param cwd - Project root.
 * @param env - Base environment (default `process.env`).
 */
export function seedEnv(cwd: string, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  // Windows spells it `Path`; keep whichever key is already there.
  const key = Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
  const bin = path.join(cwd, "node_modules", ".bin");
  const current = env[key];
  return { ...env, [key]: current ? `${bin}${path.delimiter}${current}` : bin };
}

/**
 * Run a seed command through the shell from the project root, with stdio inherited.
 *
 * @param cwd - Project root (the command's working directory).
 * @param command - Shell command from `cyphra.json` `"seed"`.
 * @returns The command's exit code (1 when it was killed by a signal).
 */
export function runSeedCommand(cwd: string, command: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, { cwd, env: seedEnv(cwd), shell: true, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}

/**
 * `cyphra db seed`: run the `"seed"` command from `cyphra.json`.
 *
 * @param cwd - Project root.
 * @param config - Loaded config.
 * @returns Exit code to propagate (the seed command's own, or 1 when no seed is configured).
 */
export async function runDbSeed(cwd: string, config: CyphraConfig): Promise<number> {
  if (!config.seed) {
    console.error(
      'No seed command configured: add "seed" to cyphra.json, for example "seed": "tsx seed.ts".',
    );
    return 1;
  }
  console.log(`Running seed: ${config.seed}`);
  const code = await runSeedCommand(cwd, config.seed);
  if (code !== 0) console.error(`Seed command exited with code ${code}.`);
  return code;
}
