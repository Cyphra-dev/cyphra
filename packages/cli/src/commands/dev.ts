import { spawnSync } from "node:child_process";
import { access, writeFile } from "node:fs/promises";
import path from "node:path";

export type DevOptions = {
  readonly stop?: boolean;
  readonly reset?: boolean;
  readonly port?: number;
  readonly httpPort?: number;
  readonly image?: string;
};

/** Local-only credentials: the container only listens on 127.0.0.1. */
export const DEV_USER = "neo4j";
export const DEV_PASSWORD = "cyphra-dev-password";

function docker(args: string[], opts: { quiet?: boolean } = {}) {
  const r = spawnSync("docker", args, { encoding: "utf8" });
  if (r.error) {
    throw new Error("Docker is required for `cyphra dev` (could not run the docker CLI).");
  }
  if (r.status !== 0 && !opts.quiet) {
    throw new Error(`docker ${args[0]} failed: ${(r.stderr || r.stdout).trim()}`);
  }
  return r;
}

export function devContainerName(cwd: string): string {
  const base = path
    .basename(cwd)
    .toLowerCase()
    .replace(/[^a-z0-9_.-]/g, "-")
    .replace(/^[^a-z0-9]+/, "");
  return `cyphra-dev-${base || "project"}`;
}

function state(name: string): "missing" | "running" | "stopped" {
  const r = docker(["inspect", "-f", "{{.State.Running}}", name], { quiet: true });
  if (r.status !== 0) return "missing";
  return r.stdout.trim() === "true" ? "running" : "stopped";
}

async function waitReady(name: string, timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = docker(
      ["exec", name, "cypher-shell", "-u", DEV_USER, "-p", DEV_PASSWORD, "RETURN 1"],
      {
        quiet: true,
      },
    );
    if (r.status === 0) return;
    await new Promise((res) => setTimeout(res, 2000));
  }
  throw new Error(`Neo4j in ${name} did not become ready in time (see: docker logs ${name}).`);
}

/**
 * `cyphra dev`: run a local Neo4j 5 in Docker for this project (data persisted in a named volume),
 * wait until it accepts connections, and write `.env` if the project has none.
 */
export async function runDev(cwd: string, opts: DevOptions): Promise<void> {
  const name = devContainerName(cwd);
  const volume = `${name}-data`;

  if (opts.stop) {
    if (state(name) === "running") docker(["stop", name]);
    console.log(`Stopped ${name}.`);
    return;
  }
  if (opts.reset) {
    docker(["rm", "-f", name], { quiet: true });
    docker(["volume", "rm", volume], { quiet: true });
    console.log(`Removed ${name} and its data volume.`);
    return;
  }

  const port = opts.port ?? 7687;
  const httpPort = opts.httpPort ?? 7474;
  const s = state(name);
  if (s === "missing") {
    docker([
      "run",
      "-d",
      "--name",
      name,
      "-p",
      `127.0.0.1:${port}:7687`,
      "-p",
      `127.0.0.1:${httpPort}:7474`,
      "-e",
      `NEO4J_AUTH=${DEV_USER}/${DEV_PASSWORD}`,
      "-v",
      `${volume}:/data`,
      opts.image ?? "neo4j:5",
    ]);
    console.log(`Started ${name}; waiting for Neo4j…`);
  } else if (s === "stopped") {
    docker(["start", name]);
    console.log(`Restarted ${name}; waiting for Neo4j…`);
  }
  await waitReady(name);

  const portLine = docker(["port", name, "7687/tcp"]).stdout.trim().split("\n")[0] ?? "";
  const hostPort = portLine.split(":").pop() || String(port);
  const env = [
    `NEO4J_URI=bolt://127.0.0.1:${hostPort}`,
    `NEO4J_USERNAME=${DEV_USER}`,
    `NEO4J_PASSWORD=${DEV_PASSWORD}`,
    "",
  ].join("\n");

  const envPath = path.join(cwd, ".env");
  const hasEnv = await access(envPath).then(
    () => true,
    () => false,
  );
  if (!hasEnv) {
    await writeFile(
      envPath,
      `# Written by \`cyphra dev\` (local container ${name})\n${env}`,
      "utf8",
    );
    console.log("Wrote .env");
  }
  console.log(`Neo4j is ready (browser: http://127.0.0.1:${httpPort}).`);
  if (hasEnv) console.log(`Connection settings (add to your .env if needed):\n${env}`);
  console.log("Stop with `cyphra dev --stop`; delete all data with `cyphra dev --reset`.");
}
