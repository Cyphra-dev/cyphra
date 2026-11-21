#!/usr/bin/env node
// `cyphra-language-server --stdio`: the Cyphra language server for any LSP client.
import { startServer } from "./server.js";

if (!process.argv.some((a) => a === "--stdio" || a === "--node-ipc" || a.startsWith("--socket"))) {
  process.argv.push("--stdio");
}
startServer();
