import lsp from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import { analyze, type Analysis, type Span } from "./analysis.js";
import { completionsAt, type CompletionKind } from "./completion.js";
import { BUILTIN_TYPES } from "./docs.js";
import { hoverAt } from "./hover.js";
import { formatText, outline, type OutlineKind, type OutlineSymbol } from "./outline.js";
import { definitionAt, referencesAt, renameEdits, renameTargetAt } from "./symbols.js";

const {
  CompletionItemKind,
  DiagnosticSeverity,
  InsertTextFormat,
  MarkupKind,
  ProposedFeatures,
  ResponseError,
  SymbolKind,
  TextDocumentSyncKind,
  TextDocuments,
  createConnection,
} = lsp;

type Connection = lsp.Connection;

const COMPLETION_KINDS: Record<CompletionKind, lsp.CompletionItemKind> = {
  keyword: CompletionItemKind.Keyword,
  type: CompletionItemKind.TypeParameter,
  node: CompletionItemKind.Class,
  relationship: CompletionItemKind.Interface,
  enum: CompletionItemKind.Enum,
  enumMember: CompletionItemKind.EnumMember,
  decorator: CompletionItemKind.Function,
  property: CompletionItemKind.Property,
  value: CompletionItemKind.Value,
  field: CompletionItemKind.Field,
  function: CompletionItemKind.Function,
  snippet: CompletionItemKind.Snippet,
};

const SYMBOL_KINDS: Record<OutlineKind, lsp.SymbolKind> = {
  node: SymbolKind.Class,
  relationship: SymbolKind.Interface,
  enum: SymbolKind.Enum,
  field: SymbolKind.Field,
  enumMember: SymbolKind.EnumMember,
  attribute: SymbolKind.Property,
};

/** Name of the diagnostics source shown by editors. */
export const DIAGNOSTIC_SOURCE = "cyphra";

/**
 * Start the Cyphra language server. Without a connection it reads the transport from the command
 * line (`--stdio`, `--node-ipc` or `--socket=<port>`), as `vscode-languageserver` does.
 *
 * @param connection - An existing LSP connection (tests, embedding).
 */
export function startServer(
  connection: Connection = createConnection(ProposedFeatures.all),
): Connection {
  const documents = new TextDocuments(TextDocument);
  const cache = new Map<string, { version: number; analysis: Analysis }>();

  const analysisOf = (doc: TextDocument): Analysis => {
    const hit = cache.get(doc.uri);
    if (hit && hit.version === doc.version) return hit.analysis;
    const analysis = analyze(doc.getText());
    cache.set(doc.uri, { version: doc.version, analysis });
    return analysis;
  };
  const range = (doc: TextDocument, s: Span): lsp.Range => ({
    start: doc.positionAt(s.start),
    end: doc.positionAt(s.end),
  });
  const withDoc = <T>(uri: string, fn: (doc: TextDocument, a: Analysis) => T): T | null => {
    const doc = documents.get(uri);
    return doc ? fn(doc, analysisOf(doc)) : null;
  };

  connection.onInitialize(() => ({
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      completionProvider: { triggerCharacters: ["@", "(", ":", "[", ",", '"'] },
      hoverProvider: true,
      definitionProvider: true,
      referencesProvider: true,
      documentSymbolProvider: true,
      documentFormattingProvider: true,
      renameProvider: { prepareProvider: true },
    },
    serverInfo: { name: "cyphra-language-server" },
  }));

  const publish = (doc: TextDocument) => {
    const { problem } = analysisOf(doc);
    const diagnostics: lsp.Diagnostic[] = problem
      ? [
          {
            range: range(doc, problem.span),
            message: problem.message,
            severity: DiagnosticSeverity.Error,
            source: DIAGNOSTIC_SOURCE,
            code: problem.kind,
          },
        ]
      : [];
    void connection.sendDiagnostics({ uri: doc.uri, version: doc.version, diagnostics });
  };
  documents.onDidChangeContent((e) => publish(e.document));
  documents.onDidClose((e) => {
    cache.delete(e.document.uri);
    void connection.sendDiagnostics({ uri: e.document.uri, diagnostics: [] });
  });

  connection.onCompletion((p) =>
    withDoc(p.textDocument.uri, (doc, a) =>
      completionsAt(a, doc.offsetAt(p.position)).map((c): lsp.CompletionItem => ({
        label: c.label,
        kind: COMPLETION_KINDS[c.kind],
        ...(c.detail ? { detail: c.detail } : {}),
        ...(c.documentation
          ? { documentation: { kind: MarkupKind.Markdown, value: c.documentation } }
          : {}),
        ...(c.sortText ? { sortText: c.sortText } : {}),
        ...(c.filterText ? { filterText: c.filterText } : {}),
        insertTextFormat: c.snippet ? InsertTextFormat.Snippet : InsertTextFormat.PlainText,
        textEdit: { range: range(doc, c.replace), newText: c.insertText ?? c.label },
      })),
    ),
  );

  connection.onHover((p) =>
    withDoc(p.textDocument.uri, (doc, a) => {
      const h = hoverAt(a, doc.offsetAt(p.position));
      return h
        ? { contents: { kind: MarkupKind.Markdown, value: h.markdown }, range: range(doc, h.span) }
        : null;
    }),
  );

  connection.onDefinition((p) =>
    withDoc(p.textDocument.uri, (doc, a) => {
      const s = definitionAt(a, doc.offsetAt(p.position));
      return s ? { uri: doc.uri, range: range(doc, s) } : null;
    }),
  );

  connection.onReferences((p) =>
    withDoc(p.textDocument.uri, (doc, a) =>
      referencesAt(a, doc.offsetAt(p.position), p.context.includeDeclaration).map((s) => ({
        uri: doc.uri,
        range: range(doc, s),
      })),
    ),
  );

  const toSymbol = (doc: TextDocument, s: OutlineSymbol): lsp.DocumentSymbol => ({
    name: s.name,
    kind: SYMBOL_KINDS[s.kind],
    ...(s.detail ? { detail: s.detail } : {}),
    range: range(doc, s.span),
    selectionRange: range(doc, s.selection),
    children: s.children.map((c) => toSymbol(doc, c)),
  });
  connection.onDocumentSymbol((p) =>
    withDoc(p.textDocument.uri, (doc, a) => outline(a).map((s) => toSymbol(doc, s))),
  );

  connection.onDocumentFormatting((p) =>
    withDoc(p.textDocument.uri, (doc) => {
      const text = doc.getText();
      const out = formatText(text);
      return out === undefined
        ? []
        : [{ range: range(doc, { start: 0, end: text.length }), newText: out }];
    }),
  );

  connection.onPrepareRename((p) =>
    withDoc(p.textDocument.uri, (doc, a) => {
      const t = renameTargetAt(a, doc.offsetAt(p.position));
      return t ? { range: range(doc, t), placeholder: t.name } : null;
    }),
  );

  connection.onRenameRequest((p) =>
    withDoc(p.textDocument.uri, (doc, a) => {
      let spans: Span[] | undefined;
      try {
        spans = renameEdits(a, doc.offsetAt(p.position), p.newName, BUILTIN_TYPES);
      } catch (err) {
        return new ResponseError(lsp.ErrorCodes.InvalidParams, (err as Error).message);
      }
      if (!spans) return null;
      return {
        changes: { [doc.uri]: spans.map((s) => ({ range: range(doc, s), newText: p.newName })) },
      };
    }),
  );

  documents.listen(connection);
  connection.listen();
  return connection;
}
