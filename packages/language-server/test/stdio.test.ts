import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const bin = fileURLToPath(new URL("../dist/bin.js", import.meta.url));

/** A minimal JSON-RPC client over the server's stdio (what Neovim / Zed / Helix do). */
function client(proc: ChildProcessWithoutNullStreams) {
  let buf = Buffer.alloc(0);
  const waiting: {
    match: (m: Record<string, unknown>) => boolean;
    resolve: (m: unknown) => void;
  }[] = [];
  proc.stdout.on("data", (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      const head = buf.indexOf("\r\n\r\n");
      if (head < 0) return;
      const len = Number(/Content-Length: (\d+)/i.exec(buf.subarray(0, head).toString())?.[1]);
      if (buf.length < head + 4 + len) return;
      const msg = JSON.parse(buf.subarray(head + 4, head + 4 + len).toString()) as Record<
        string,
        unknown
      >;
      buf = buf.subarray(head + 4 + len);
      const i = waiting.findIndex((w) => w.match(msg));
      if (i >= 0) waiting.splice(i, 1)[0]!.resolve(msg);
    }
  });
  const send = (msg: object) => {
    const body = JSON.stringify({ jsonrpc: "2.0", ...msg });
    proc.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  };
  const wait = <T>(match: (m: Record<string, unknown>) => boolean) =>
    new Promise<T>((resolve) => waiting.push({ match, resolve: resolve as (m: unknown) => void }));
  let id = 0;
  return {
    send,
    wait,
    request: <T>(method: string, params: object) => {
      const reqId = ++id;
      send({ id: reqId, method, params });
      return wait<{ result: T }>((m) => m.id === reqId).then((m) => m.result);
    },
  };
}

describe.skipIf(!existsSync(bin))("cyphra-language-server --stdio", () => {
  let proc: ChildProcessWithoutNullStreams | undefined;
  afterEach(() => proc?.kill());

  it("initializes, publishes diagnostics and formats", async () => {
    proc = spawn(process.execPath, [bin, "--stdio"]);
    const c = client(proc);
    const init = await c.request<{ capabilities: Record<string, unknown> }>("initialize", {
      processId: null,
      rootUri: null,
      capabilities: {},
    });
    expect(init.capabilities).toMatchObject({
      hoverProvider: true,
      definitionProvider: true,
      documentFormattingProvider: true,
    });
    c.send({ method: "initialized", params: {} });
    const uri = "file:///schema.cyphra";
    const diagnostics = c.wait<{ params: { diagnostics: { message: string; range: unknown }[] } }>(
      (m) => m.method === "textDocument/publishDiagnostics",
    );
    c.send({
      method: "textDocument/didOpen",
      params: {
        textDocument: {
          uri,
          languageId: "cyphra",
          version: 1,
          text: 'node User {\n  id String @id\n  a Post @relationship(type: "X")\n}\n',
        },
      },
    });
    const d = await diagnostics;
    expect(d.params.diagnostics).toHaveLength(1);
    expect(d.params.diagnostics[0]).toMatchObject({
      message: expect.stringContaining('unknown node "Post"'),
      range: { start: { line: 2, character: 4 }, end: { line: 2, character: 8 } },
    });
    const edits = await c.request<{ newText: string }[]>("textDocument/formatting", {
      textDocument: { uri },
      options: { tabSize: 2, insertSpaces: true },
    });
    expect(edits.map((e) => e.newText)).toEqual([
      'node User {\n  id String @id\n  a  Post   @relationship(type: "X")\n}\n',
    ]);
  }, 20_000);
});
