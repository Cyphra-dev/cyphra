/**
 * Hardware and software of a run, written into the results file. Only machine specs and versions:
 * no host name, user name or path.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import os from "node:os";
import type { Driver } from "neo4j-driver";

/** Version of a dependency of this workspace (bench/node_modules, also when run from dist/). */
function pkgVersion(name: string): string {
  try {
    const url = new URL(`../node_modules/${name}/package.json`, import.meta.url);
    return (JSON.parse(readFileSync(url, "utf8")) as { version: string }).version;
  } catch {
    return "unknown";
  }
}

function osName(): string {
  try {
    const release = readFileSync("/etc/os-release", "utf8");
    const pretty = /^PRETTY_NAME="?([^"\n]*)"?/m.exec(release)?.[1];
    if (pretty) return `${pretty} (${os.type()} ${os.release()})`;
  } catch {
    // not Linux
  }
  return `${os.type()} ${os.release()}`;
}

function gitCommit(): string | undefined {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return undefined;
  }
}

export type Environment = Awaited<ReturnType<typeof captureEnvironment>>;

export async function captureEnvironment(driver: Driver, database: string) {
  const session = driver.session({ database });
  let neo4jVersion = "unknown";
  let neo4jEdition = "unknown";
  try {
    const res = await session.run(
      "CALL dbms.components() YIELD name, versions, edition RETURN versions[0] AS v, edition AS e",
    );
    neo4jVersion = res.records[0]?.get("v") ?? neo4jVersion;
    neo4jEdition = res.records[0]?.get("e") ?? neo4jEdition;
  } finally {
    await session.close();
  }
  const cpus = os.cpus();
  return {
    cpu: cpus[0]?.model.trim() ?? "unknown",
    cores: cpus.length,
    memoryGb: Math.round(os.totalmem() / 1024 ** 3),
    os: osName(),
    arch: os.arch(),
    node: process.version,
    neo4j: `${neo4jVersion} ${neo4jEdition}`,
    commit: gitCommit(),
    packages: {
      "neo4j-driver": pkgVersion("neo4j-driver"),
      cyphra: pkgVersion("cyphra"),
      "@cyphra/graphql": pkgVersion("@cyphra/graphql"),
      "@neo4j/graphql": pkgVersion("@neo4j/graphql"),
      neogma: pkgVersion("neogma"),
      graphql: pkgVersion("graphql"),
      tinybench: pkgVersion("tinybench"),
    },
  };
}
