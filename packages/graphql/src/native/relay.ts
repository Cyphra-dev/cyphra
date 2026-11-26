/**
 * Relay global ids (`relay: true`): `base64("<Type>:<key>")`, the key being the node's `@id`.
 *
 * @packageDocumentation
 */

import type { ResolvedScalarField } from "@cyphra/schema";

function base64(text: string): string {
  let bin = "";
  for (const b of new TextEncoder().encode(text)) bin += String.fromCharCode(b);
  return btoa(bin);
}

function unbase64(text: string): string | undefined {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text)) return undefined;
  try {
    const bin = atob(text);
    return new TextDecoder("utf-8", { fatal: true }).decode(
      Uint8Array.from(bin, (c) => c.charCodeAt(0)),
    );
  } catch {
    return undefined;
  }
}

/** The global id of the node of type `type` whose key is `key`. */
export function toGlobalId(type: string, key: unknown): string {
  return base64(`${type}:${String(key)}`);
}

/** `{ type, key }` of a global id (the key as text), or `undefined` when it is not one. */
export function fromGlobalId(id: string): { type: string; key: string } | undefined {
  const text = unbase64(id);
  const i = text?.indexOf(":") ?? -1;
  if (text === undefined || i <= 0) return undefined;
  return { type: text.slice(0, i), key: text.slice(i + 1) };
}

/** The key of a global id as a value of the key field (`undefined` when it is not one). */
export function keyValue(field: ResolvedScalarField, key: string): unknown {
  switch (field.type) {
    case "Int": {
      const n = Number(key);
      return /^-?\d+$/.test(key) && Number.isSafeInteger(n) ? n : undefined;
    }
    case "BigInt":
      return /^-?\d+$/.test(key) ? BigInt(key) : undefined;
    default:
      return key;
  }
}
