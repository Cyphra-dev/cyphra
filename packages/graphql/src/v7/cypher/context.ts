/** Parameters and fresh variable names for one Cypher statement. */
export class CypherContext {
  readonly params: Record<string, unknown> = {};
  private paramCount = 0;
  private varCount = 0;

  /** Bind a value and return its `$placeholder`. */
  param(value: unknown): string {
    const key = `p${this.paramCount++}`;
    this.params[key] = value;
    return `$${key}`;
  }

  /** Fresh variable name, e.g. `this0`. */
  variable(prefix = "this"): string {
    return `${prefix}${this.varCount++}`;
  }
}

/** Quote an identifier (label, property key, relationship type, map key) for Cypher. */
export function q(id: string): string {
  return "`" + id.replace(/`/g, "``") + "`";
}

/** `:`A`:`B`` for a list of labels. */
export function labels(ls: readonly string[]): string {
  return ls.map((l) => `:${q(l)}`).join("");
}
