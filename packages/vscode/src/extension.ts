import * as vscode from "vscode";
import {
  LanguageClient,
  TransportKind,
  type LanguageClientOptions,
  type ServerOptions,
} from "vscode-languageclient/node";

const LANGUAGE_ID = "cyphra";

let client: LanguageClient | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const serverModule = context.asAbsolutePath("dist/server.js");
  const serverOptions: ServerOptions = {
    run: { module: serverModule, transport: TransportKind.ipc },
    debug: {
      module: serverModule,
      transport: TransportKind.ipc,
      options: { execArgv: ["--nolazy", "--inspect=6019"] },
    },
  };
  const clientOptions: LanguageClientOptions = {
    documentSelector: [
      { scheme: "file", language: LANGUAGE_ID },
      { scheme: "untitled", language: LANGUAGE_ID },
    ],
  };
  client = new LanguageClient("cyphra", "Cyphra Language Server", serverOptions, clientOptions);

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  status.name = "Cyphra schema";
  const updateStatus = () => updateStatusItem(status);

  context.subscriptions.push(
    status,
    vscode.commands.registerCommand("cyphra.generate", () => generateClient()),
    vscode.commands.registerCommand("cyphra.restartServer", () => client?.restart()),
    vscode.window.onDidChangeActiveTextEditor(updateStatus),
    vscode.languages.onDidChangeDiagnostics(updateStatus),
  );
  updateStatus();
  await client.start();
}

export async function deactivate(): Promise<void> {
  await client?.stop();
  client = undefined;
}

/** Status bar: schema valid, or the first error (click to open the Problems view). */
function updateStatusItem(item: vscode.StatusBarItem): void {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== LANGUAGE_ID) {
    item.hide();
    return;
  }
  const errors = vscode.languages
    .getDiagnostics(editor.document.uri)
    .filter((d) => d.source === "cyphra" && d.severity === vscode.DiagnosticSeverity.Error);
  if (errors.length) {
    item.text = "$(error) Cyphra";
    item.tooltip = `Schema error: ${errors[0]!.message}`;
    item.command = "workbench.actions.view.problems";
    item.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
  } else {
    item.text = "$(check) Cyphra";
    item.tooltip = "Schema is valid. Click to generate the client.";
    item.command = "cyphra.generate";
    item.backgroundColor = undefined;
  }
  item.show();
}

async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

/** Directories from `start` up to (and including) `stop`. */
function ancestors(start: vscode.Uri, stop: vscode.Uri): vscode.Uri[] {
  const out: vscode.Uri[] = [];
  let dir = start;
  for (;;) {
    out.push(dir);
    if (dir.path === stop.path || !dir.path.startsWith(stop.path)) break;
    const parent = vscode.Uri.joinPath(dir, "..");
    if (parent.path === dir.path) break;
    dir = parent;
  }
  return out;
}

/** `cyphra generate` through the project's package manager (from its lockfile). */
async function defaultCommand(dirs: readonly vscode.Uri[]): Promise<string> {
  const managers: [string, string][] = [
    ["pnpm-lock.yaml", "pnpm exec cyphra generate"],
    ["yarn.lock", "yarn cyphra generate"],
    ["bun.lock", "bunx cyphra generate"],
    ["bun.lockb", "bunx cyphra generate"],
  ];
  for (const dir of dirs) {
    for (const [lockfile, command] of managers) {
      if (await exists(vscode.Uri.joinPath(dir, lockfile))) return command;
    }
  }
  return "npx cyphra generate";
}

/** Run `cyphra generate` in a terminal, from the folder holding the schema's `cyphra.json`. */
async function generateClient(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  const schema = editor?.document.languageId === LANGUAGE_ID ? editor.document.uri : undefined;
  const folder =
    (schema && vscode.workspace.getWorkspaceFolder(schema)) ??
    vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    void vscode.window.showErrorMessage("Cyphra: open the folder of a Cyphra project first.");
    return;
  }
  const dirs = schema ? ancestors(vscode.Uri.joinPath(schema, ".."), folder.uri) : [folder.uri];
  let cwd = folder.uri;
  for (const dir of dirs) {
    if (await exists(vscode.Uri.joinPath(dir, "cyphra.json"))) {
      cwd = dir;
      break;
    }
  }
  const configured = vscode.workspace
    .getConfiguration("cyphra", folder.uri)
    .get<string>("generateCommand", "")
    .trim();
  const command = configured || (await defaultCommand(ancestors(cwd, folder.uri)));
  const name = `Cyphra (${cwd.path.split("/").pop() ?? folder.name})`;
  const terminal =
    vscode.window.terminals.find((t) => t.name === name && t.exitStatus === undefined) ??
    vscode.window.createTerminal({ name, cwd });
  terminal.show(true);
  terminal.sendText(command);
}
