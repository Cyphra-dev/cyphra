import path from "node:path";

/**
 * Resolve `p` under `root` and throw if the result escapes `root` (path traversal guard).
 *
 * @param root - Project root directory (absolute).
 * @param p - Path segment or relative path from config.
 * @returns Absolute normalized path under `root`.
 */
export function resolveUnderRoot(root: string, p: string): string {
  const absRoot = path.resolve(root);
  const resolved = path.resolve(absRoot, p);
  const rel = path.relative(absRoot, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Path escapes project root: ${p}`);
  }
  return resolved;
}
