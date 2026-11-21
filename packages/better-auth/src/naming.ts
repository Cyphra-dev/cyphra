/** Name conversions between Better Auth model / field names and Cyphra schema names. */

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Split `user_custom`, `oneToOneTable`, `API-key` into lower-case words. */
function words(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

const capitalize = (w: string) => w.charAt(0).toUpperCase() + w.slice(1);

/** `user` → `User`, `user_custom` → `UserCustom`, `twoFactor` → `TwoFactor`. */
export function pascalCase(name: string): string {
  const out = words(name).map(capitalize).join("");
  return /^[0-9]/.test(out) ? `_${out}` : out;
}

/** `TwoFactor` → `TWO_FACTOR`. */
export function upperSnake(name: string): string {
  return words(name)
    .map((w) => w.toUpperCase())
    .join("_");
}

/** `TwoFactor` → `twoFactor`. */
export function lowerFirst(name: string): string {
  return name.charAt(0).toLowerCase() + name.slice(1);
}

/** English plural good enough for field names: `session` → `sessions`, `policy` → `policies`. */
export function plural(name: string): string {
  if (/[^aeiou]y$/i.test(name)) return `${name.slice(0, -1)}ies`;
  if (/(s|x|z|ch|sh)$/i.test(name)) return `${name}es`;
  return `${name}s`;
}

/** Relationship type from a parent to a child node: `Session` → `HAS_SESSION`. */
export function edgeType(childNode: string, suffix?: string): string {
  const parts = [upperSnake(childNode), ...(suffix ? [upperSnake(suffix)] : [])].filter(Boolean);
  return `HAS_${parts.join("_") || "RELATED"}`;
}

/**
 * Name of the to-one relation field that replaces a foreign key on the child:
 * `userId` → `user`, `organization_id` → `organization`, `inviterId` → `inviter`.
 * Returns the foreign-key name itself when there is no `Id` suffix to strip.
 */
export function relationFieldName(fkName: string): string {
  const m = /^(.+?)(?:_id|Id|ID)$/.exec(fkName);
  return m && m[1] ? m[1] : fkName;
}

/** Throw when `name` cannot be written as a `.cyphra` identifier. */
export function assertIdentifier(name: string, what: string): string {
  if (!IDENTIFIER.test(name)) {
    throw new Error(
      `@cyphra/better-auth: ${what} "${name}" is not a valid Cyphra identifier (letters, digits and _; must not start with a digit).`,
    );
  }
  return name;
}
