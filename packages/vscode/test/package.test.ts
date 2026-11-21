import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = (p: string) => fileURLToPath(new URL(`../${p}`, import.meta.url));
const manifest = JSON.parse(readFileSync(root("package.json"), "utf8")) as {
  main: string;
  icon: string;
  engines: { vscode: string };
  devDependencies: Record<string, string>;
  contributes: {
    languages: { configuration: string; icon: { light: string; dark: string } }[];
    grammars: { path: string }[];
    snippets: { path: string }[];
    commands: { command: string }[];
  };
};

describe("extension manifest", () => {
  it("points at files that exist (after the build)", () => {
    const c = manifest.contributes;
    const files = [
      manifest.icon,
      ...c.languages.flatMap((l) => [l.configuration, l.icon.light, l.icon.dark]),
      ...c.snippets.map((s) => s.path),
    ];
    for (const f of files) expect(existsSync(root(f)), f).toBe(true);
    for (const f of [...c.snippets.map((s) => s.path), c.languages[0]!.configuration]) {
      expect(() => JSON.parse(readFileSync(root(f), "utf8"))).not.toThrow();
    }
  });

  it("registers every contributed command", () => {
    const source = readFileSync(root("src/extension.ts"), "utf8");
    for (const { command } of manifest.contributes.commands) {
      expect(source).toContain(`registerCommand("${command}"`);
    }
  });

  it("keeps @types/vscode within the supported engine (vsce rejects newer types)", () => {
    expect(manifest.engines.vscode).toBe(`^${manifest.devDependencies["@types/vscode"]}`);
  });
});

describe.skipIf(!existsSync(root("dist/server.js")))("bundled language server", () => {
  it("answers initialize over stdio", async () => {
    const proc = spawn(process.execPath, [root("dist/server.js"), "--stdio"]);
    try {
      const body = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { processId: null, rootUri: null, capabilities: {} },
      });
      proc.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
      const reply = await new Promise<string>((resolve) => {
        let out = "";
        proc.stdout.on("data", (d: Buffer) => {
          out += d.toString();
          if (out.includes('"serverInfo"')) resolve(out);
        });
      });
      expect(reply).toContain('"name":"cyphra-language-server"');
    } finally {
      proc.kill();
    }
  }, 20_000);
});
