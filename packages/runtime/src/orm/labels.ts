/**
 * Dynamic labels (`@@labels([Archived, Featured])`): flags a node may carry or not, written with
 * `data: { $labels }` and filtered with `where: { $labels }`.
 *
 * Label names only ever come from the schema's allow-list: a value given at runtime is looked up
 * in {@link ResolvedNodeModel.dynamicLabels} and rejected when it is not there, and the Cypher is
 * written with the schema's own (backtick-quoted) name. So the statements use plain label
 * expressions (`SET n:Archived`, `n:Archived` in a `WHERE`), which every supported database
 * understands, and no label is ever taken from a value.
 *
 * @packageDocumentation
 */

import type { ResolvedNodeModel } from "@cyphra/schema";
import { CyphraValidationError } from "./errors.js";

/** Quote a label for Cypher (same rules as `q` in compile.ts). */
function quote(id: string): string {
  return "`" + id.replace(/`/g, "``") + "`";
}

type AnyRecord = Record<string, unknown>;

function isPlainObject(v: unknown): v is AnyRecord {
  return typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Date);
}

/** The dynamic labels `model` declares (and inherits), in declaration order. */
export function dynamicLabelsOf(model: ResolvedNodeModel): readonly string[] {
  return model.dynamicLabels ?? [];
}

/** What a model without `@@labels` says when `$labels` is used on it. */
function noLabels(model: ResolvedNodeModel, where: string): CyphraValidationError {
  return new CyphraValidationError(
    `${where}: ${model.name} declares no dynamic labels (add @@labels([…]) to the model).`,
  );
}

/** The schema's label for `value`, or a validation error when it is not in the allow-list. */
export function dynamicLabel(model: ResolvedNodeModel, value: unknown, where: string): string {
  const allowed = dynamicLabelsOf(model);
  if (allowed.length === 0) throw noLabels(model, where);
  const label = typeof value === "string" ? allowed.find((l) => l === value) : undefined;
  if (label === undefined) {
    throw new CyphraValidationError(
      `${where} on ${model.name}: expected ${allowed.map((l) => JSON.stringify(l)).join(" | ")}, got ${JSON.stringify(value)}.`,
    );
  }
  return label;
}

/** The schema's labels for an array of values (each once, in the order given). */
export function dynamicLabelList(
  model: ResolvedNodeModel,
  value: unknown,
  where: string,
): string[] {
  if (!Array.isArray(value)) {
    if (dynamicLabelsOf(model).length === 0) throw noLabels(model, where);
    throw new CyphraValidationError(`${where} on ${model.name} expects an array of labels.`);
  }
  return [...new Set(value.map((v) => dynamicLabel(model, v, where)))];
}

/** `` alias:`A`:`B` `` (a `SET` item or a predicate), or `null` for no labels. */
export function labelItem(alias: string, labels: readonly string[]): string | null {
  return labels.length ? `${alias}:${labels.map(quote).join(":")}` : null;
}

/** `` :`A`:`B` `` to append to a node pattern's label expression (`""` for no labels). */
export function labelSuffix(labels: readonly string[]): string {
  return labels.map((l) => `:${quote(l)}`).join("");
}

/**
 * `$labels` in `where`: `{ has, hasSome, hasEvery, hasNone, isEmpty }`, compiled to label
 * predicates on `alias` (`n:Archived`, `(n:A) OR (n:B)`, …). An empty `hasSome` matches nothing,
 * an empty `hasEvery` / `hasNone` everything.
 */
export function compileLabelsFilter(
  model: ResolvedNodeModel,
  alias: string,
  filter: unknown,
): string | null {
  const where = "where.$labels";
  if (dynamicLabelsOf(model).length === 0) throw noLabels(model, where);
  if (!isPlainObject(filter)) {
    throw new CyphraValidationError(
      `${where} on ${model.name} takes { has, hasSome, hasEvery, hasNone, isEmpty }.`,
    );
  }
  const one = (l: string) => `${alias}:${quote(l)}`;
  const any = (labels: readonly string[]) =>
    labels.length === 0
      ? "false"
      : labels.length === 1
        ? one(labels[0]!)
        : labels.map((l) => `(${one(l)})`).join(" OR ");
  const parts: string[] = [];
  for (const [op, v] of Object.entries(filter)) {
    if (v === undefined) continue;
    const at = `${where}.${op}`;
    switch (op) {
      case "has":
        parts.push(one(dynamicLabel(model, v, at)));
        break;
      case "hasSome":
        parts.push(any(dynamicLabelList(model, v, at)));
        break;
      case "hasEvery": {
        const labels = dynamicLabelList(model, v, at);
        if (labels.length) parts.push(labelItem(alias, labels)!);
        break;
      }
      case "hasNone": {
        const labels = dynamicLabelList(model, v, at);
        if (labels.length) parts.push(`NOT (${any(labels)})`);
        break;
      }
      case "isEmpty": {
        if (typeof v !== "boolean") {
          throw new CyphraValidationError(`${at} on ${model.name} must be true or false.`);
        }
        const some = any(dynamicLabelsOf(model));
        parts.push(v ? `NOT (${some})` : some);
        break;
      }
      default:
        throw new CyphraValidationError(
          `Unknown filter "${op}" on ${model.name}.$labels (use has, hasSome, hasEvery, hasNone, isEmpty).`,
        );
    }
  }
  if (parts.length === 0) return null;
  return parts.length === 1 ? parts[0]! : parts.map((p) => `(${p})`).join(" AND ");
}

/** Labels a write adds to and removes from a node. */
export type LabelChange = { readonly add: readonly string[]; readonly remove: readonly string[] };

export const NO_LABEL_CHANGE: LabelChange = { add: [], remove: [] };

/** `$labels` of a create: the labels the new node gets (`["Archived"]`). */
export function createLabels(model: ResolvedNodeModel, value: unknown, where: string): string[] {
  if (value === undefined) return [];
  return dynamicLabelList(model, value, `${where}.$labels`);
}

/**
 * `$labels` of an update: `{ add, remove }` (a label in both is an error) or `{ set }` (exactly
 * these labels: every other declared label is removed).
 */
export function updateLabels(model: ResolvedNodeModel, value: unknown, where: string): LabelChange {
  if (value === undefined) return NO_LABEL_CHANGE;
  const at = `${where}.$labels`;
  if (dynamicLabelsOf(model).length === 0) throw noLabels(model, at);
  if (!isPlainObject(value)) {
    throw new CyphraValidationError(`${at} on ${model.name} takes { add, remove } or { set }.`);
  }
  for (const k of Object.keys(value)) {
    if (k !== "add" && k !== "remove" && k !== "set") {
      throw new CyphraValidationError(
        `Unknown ${at} operation "${k}" on ${model.name} (use add, remove or set).`,
      );
    }
  }
  if (value.set !== undefined) {
    if (value.add !== undefined || value.remove !== undefined) {
      throw new CyphraValidationError(`${at} on ${model.name}: use set alone, or add / remove.`);
    }
    const add = dynamicLabelList(model, value.set, `${at}.set`);
    return { add, remove: dynamicLabelsOf(model).filter((l) => !add.includes(l)) };
  }
  const add = value.add === undefined ? [] : dynamicLabelList(model, value.add, `${at}.add`);
  const remove =
    value.remove === undefined ? [] : dynamicLabelList(model, value.remove, `${at}.remove`);
  const both = add.find((l) => remove.includes(l));
  if (both) {
    throw new CyphraValidationError(`${at} on ${model.name}: ${both} is both added and removed.`);
  }
  return { add, remove };
}

/** The labels among `labels` (as read with `labels(n)`) that are dynamic labels of `model`. */
export function decodeDynamicLabels(model: ResolvedNodeModel, labels: unknown): string[] {
  const set = new Set(Array.isArray(labels) ? labels : []);
  return dynamicLabelsOf(model).filter((l) => set.has(l));
}
