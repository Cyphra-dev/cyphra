/**
 * Format an error for stderr, including nested {@link Error.cause} chains (e.g. driver errors after DDL).
 */
export function formatCliError(err: unknown, maxDepth = 6): string {
  if (!(err instanceof Error)) {
    return String(err);
  }
  const lines: string[] = [err.message];
  let c: unknown = err.cause;
  let depth = 0;
  while (c instanceof Error && depth < maxDepth) {
    lines.push(`  Caused by: ${c.message}`);
    c = c.cause;
    depth += 1;
  }
  return lines.join("\n");
}
