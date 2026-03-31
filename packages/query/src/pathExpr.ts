function assertPathVariable(name: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`pathExpr: invalid path variable ${JSON.stringify(name)}`);
  }
}

/** `length(pathVar)` */
export function lengthPath(variable: string): string {
  assertPathVariable(variable);
  return `length(${variable})`;
}

/** `nodes(pathVar)` */
export function nodesPath(variable: string): string {
  assertPathVariable(variable);
  return `nodes(${variable})`;
}

/** `relationships(pathVar)` */
export function relationshipsPath(variable: string): string {
  assertPathVariable(variable);
  return `relationships(${variable})`;
}
