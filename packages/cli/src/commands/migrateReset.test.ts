import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CyphraConfig } from "../config.js";
import { assessUri, confirm, decideReset, isYes, runMigrateReset } from "./migrateReset.js";

describe("assessUri", () => {
  it.each([
    "bolt://localhost:7687",
    "neo4j://127.0.0.1:7687",
    "bolt://127.1.2.3",
    "bolt://[::1]:7687",
    "bolt://0.0.0.0:7687",
    "neo4j://app.localhost:7687",
    "bolt://host.docker.internal:7687",
    "bolt://neo4j:7687",
    "bolt://LOCALHOST",
  ])("treats %s as local", (uri) => {
    expect(assessUri(uri).local).toBe(true);
  });

  it.each([
    ["neo4j+s://abcd1234.databases.neo4j.io", /encrypted neo4j\+s/],
    ["bolt+ssc://localhost:7687", /encrypted bolt\+ssc/],
    ["neo4j://abcd1234.databases.neo4j.io", /Aura/],
    ["bolt://db.example.com:7687", /db\.example\.com is not a local host/],
    ["bolt://10.0.0.5:7687", /not a local host/],
    ["bolt://192.168.1.10", /not a local host/],
    ["bolt://[2001:db8::1]:7687", /not a local host/],
    ["not a uri", /could not be parsed/],
  ])("treats %s as production", (uri, reason) => {
    const a = assessUri(uri);
    expect(a.local).toBe(false);
    expect(a.reason).toMatch(reason);
  });
});

describe("decideReset", () => {
  const local = "bolt://localhost:7687";
  const remote = "neo4j+s://x.databases.neo4j.io";

  it("prompts on a local database in a terminal", () => {
    expect(decideReset(local, {}, true)).toEqual({ action: "prompt" });
  });
  it("skips the prompt with --yes or --force", () => {
    expect(decideReset(local, { yes: true }, false)).toEqual({ action: "proceed" });
    expect(decideReset(local, { force: true }, false)).toEqual({ action: "proceed" });
  });
  it("refuses without confirmation when not interactive", () => {
    const d = decideReset(local, {}, false);
    expect(d.action).toBe("refuse");
    expect(d.action === "refuse" && d.message).toMatch(/non-interactive.*--yes/);
  });
  it("refuses a production-looking URI even with --yes, unless --force", () => {
    for (const interactive of [true, false]) {
      const d = decideReset(remote, { yes: true }, interactive);
      expect(d.action).toBe("refuse");
      expect(d.action === "refuse" && d.message).toMatch(/does not look like a local.*--force/);
    }
    expect(decideReset(remote, { force: true }, false)).toEqual({ action: "proceed" });
  });
});

describe("confirmation", () => {
  it("accepts only y / yes", () => {
    for (const a of ["y", "Y", "yes", " YES "]) expect(isYes(a)).toBe(true);
    for (const a of ["", "n", "no", "yep", "ye s"]) expect(isYes(a)).toBe(false);
  });

  it("reads the answer from the terminal", async () => {
    const ask = async (answer: string) => {
      const input = new PassThrough();
      const output = new PassThrough();
      const p = confirm("Reset?", { input, output });
      input.write(`${answer}\n`);
      return p;
    };
    expect(await ask("y")).toBe(true);
    expect(await ask("")).toBe(false);
  });
});

describe("runMigrateReset (refusals, no database)", () => {
  const config: CyphraConfig = {
    schema: "/p/schema.cyphra",
    migrations: "/p/migrations",
    generate: "/p/cyphra.gen.ts",
    runtimeImport: "cyphra",
  };
  const saved = process.env.NEO4J_URI;
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    if (saved === undefined) delete process.env.NEO4J_URI;
    else process.env.NEO4J_URI = saved;
  });
  const noClient = () => {
    throw new Error("must not connect");
  };

  it("refuses a remote URI before connecting", async () => {
    process.env.NEO4J_URI = "neo4j+s://x.databases.neo4j.io";
    expect(await runMigrateReset("/p", config, { yes: true }, { client: noClient })).toBe(1);
    expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/Pass --force/));
  });

  it("stops when the prompt is declined", async () => {
    process.env.NEO4J_URI = "bolt://localhost:7687";
    const ask = vi.fn(async () => false);
    expect(
      await runMigrateReset(
        "/p",
        config,
        {},
        { interactive: true, confirm: ask, client: noClient },
      ),
    ).toBe(1);
    expect(ask).toHaveBeenCalledWith(expect.stringMatching(/Reset .* on localhost\?/));
    expect(console.error).toHaveBeenCalledWith("Reset cancelled.");
  });
});
