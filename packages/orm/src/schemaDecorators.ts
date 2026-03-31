import type { Decorator, ScalarNodeField } from "@cyphra/schema";

/** String argument on a named decorator, e.g. `@relationship(type: "X")`. */
export function decoratorStringArg(
  decorators: readonly Decorator[],
  decoratorName: string,
  argKey: string,
): string | undefined {
  const dec = decorators.find((d) => d.name === decoratorName);
  if (!dec) {
    return undefined;
  }
  const arg = dec.args.find((a) => a.key === argKey);
  if (!arg || arg.value.kind !== "string") {
    return undefined;
  }
  return arg.value.value;
}

/**
 * String or bare identifier argument (Cypher schema allows **`direction: OUT`** as an identifier).
 */
export function decoratorStringOrIdArg(
  decorators: readonly Decorator[],
  decoratorName: string,
  argKey: string,
): string | undefined {
  const dec = decorators.find((d) => d.name === decoratorName);
  if (!dec) {
    return undefined;
  }
  const arg = dec.args.find((a) => a.key === argKey);
  if (!arg) {
    return undefined;
  }
  if (arg.value.kind === "string" || arg.value.kind === "identifier") {
    return arg.value.value;
  }
  return undefined;
}

/** Identifier from `@default(cuid())` / `@default(now())` → **`cuid`**, **`now`**. */
export function getScalarDefaultFn(field: ScalarNodeField): string | undefined {
  const dec = field.decorators.find((d) => d.name === "default");
  if (!dec) {
    return undefined;
  }
  const arg = dec.args.find((a) => a.key === "fn");
  if (!arg || arg.value.kind !== "identifier") {
    return undefined;
  }
  return arg.value.value;
}
