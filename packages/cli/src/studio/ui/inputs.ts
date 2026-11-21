/** Typed inputs for schema fields: one editor per scalar type, lists, nullable wrappers. */

import type { StudioScalarField } from "../protocol.js";
import { h } from "./dom.js";

export type Read = { ok: true; value: unknown } | { ok: false; error: string };

export type Editor = {
  readonly el: HTMLElement;
  /** The value as the API takes it (JSON), or why it is invalid. */
  get(): Read;
  focus(): void;
};

const TEMPORAL_PLACEHOLDER: Record<string, string> = {
  LocalDateTime: "2024-05-01T09:30:00",
  LocalTime: "09:30:00",
  Time: "09:30:00+02:00",
  Duration: "PT1H30M",
};

/** Field type as shown in headers: `String?`, `Int[]`, `Vector(3)`, `Role`. */
export function typeLabel(f: {
  type: string;
  list?: boolean;
  optional?: boolean;
  dimensions?: number;
  enumValues?: readonly string[];
}): string {
  const base =
    f.type === "Vector" ? `Vector(${f.dimensions ?? "?"})` : f.type === "Enum" ? "enum" : f.type;
  return `${base}${f.list ? "[]" : ""}${f.optional ? "?" : ""}`;
}

function ok(value: unknown): Read {
  return { ok: true, value };
}
function fail(error: string): Read {
  return { ok: false, error };
}

/** `2024-05-01T09:30:00.000Z` → `2024-05-01T09:30:00` (shown and edited as UTC). */
function isoToLocalInput(v: unknown): string {
  return typeof v === "string" ? v.replace(/\.\d+Z$|Z$/, "").slice(0, 19) : "";
}

/** Editor of one (non-list) value of `f`. */
export function scalarEditor(f: StudioScalarField, value: unknown): Editor {
  switch (f.type) {
    case "Boolean":
    case "Enum": {
      const options = f.type === "Boolean" ? ["true", "false"] : (f.enumValues ?? []);
      const current = value === null || value === undefined ? "" : String(value);
      const sel = h(
        "select",
        null,
        current === ""
          ? h("option", { value: "", disabled: true, selected: true }, "Choose…")
          : null,
        options.map((o) => h("option", { value: o, selected: o === current }, o)),
      );
      return {
        el: sel,
        get: () =>
          sel.value === ""
            ? fail("Choose a value.")
            : ok(f.type === "Boolean" ? sel.value === "true" : sel.value),
        focus: () => sel.focus(),
      };
    }
    case "Int":
    case "Float": {
      const input = h("input", {
        type: "number",
        step: f.type === "Int" ? "1" : "any",
        value: typeof value === "number" ? String(value) : "",
      });
      return {
        el: input,
        get: () => {
          if (input.value.trim() === "") return fail("Enter a number.");
          const n = Number(input.value);
          if (!Number.isFinite(n)) return fail("Not a number.");
          if (f.type === "Int" && !Number.isInteger(n)) return fail("Enter a whole number.");
          return ok(n);
        },
        focus: () => input.focus(),
      };
    }
    case "BigInt": {
      const input = h("input", {
        type: "text",
        inputmode: "numeric",
        value: value === null || value === undefined ? "" : String(value),
      });
      return {
        el: input,
        get: () =>
          /^-?\d+$/.test(input.value.trim())
            ? ok(input.value.trim())
            : fail("Enter a whole number."),
        focus: () => input.focus(),
      };
    }
    case "DateTime": {
      const input = h("input", {
        type: "datetime-local",
        step: "1",
        value: isoToLocalInput(value),
        title: "UTC",
      });
      return {
        el: input,
        get: () => {
          const v = input.value;
          if (!v) return fail("Pick a date and time.");
          const iso = `${v.length === 16 ? `${v}:00` : v}Z`;
          return Number.isNaN(Date.parse(iso)) ? fail("Invalid date.") : ok(iso);
        },
        focus: () => input.focus(),
      };
    }
    case "Date": {
      const input = h("input", {
        type: "date",
        value: typeof value === "string" ? value.slice(0, 10) : "",
      });
      return {
        el: input,
        get: () => (input.value ? ok(input.value) : fail("Pick a date.")),
        focus: () => input.focus(),
      };
    }
    case "Json": {
      return jsonEditor(value, () => null, true);
    }
    case "Vector": {
      return jsonEditor(Array.isArray(value) ? value : [], (v) => {
        if (!Array.isArray(v) || !v.every((x) => typeof x === "number" && Number.isFinite(x))) {
          return "Expected an array of numbers.";
        }
        if (f.dimensions !== undefined && v.length !== f.dimensions) {
          return `Expected ${f.dimensions} numbers (got ${v.length}).`;
        }
        return null;
      });
    }
    case "Point":
    case "CartesianPoint": {
      const keys = f.type === "Point" ? ["longitude", "latitude", "height"] : ["x", "y", "z"];
      const o = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
      const inputs = keys.map((k) =>
        h("input", {
          type: "number",
          step: "any",
          placeholder: k === "height" || k === "z" ? `${k} (optional)` : k,
          "aria-label": k,
          value: typeof o[k] === "number" ? String(o[k]) : "",
        }),
      );
      return {
        el: h("div", { class: "row" }, inputs),
        get: () => {
          const out: Record<string, number> = {};
          for (const [i, k] of keys.entries()) {
            const t = inputs[i]!.value.trim();
            if (t === "") {
              if (i === 2) continue;
              return fail(`Enter ${k}.`);
            }
            const n = Number(t);
            if (!Number.isFinite(n)) return fail(`${k} is not a number.`);
            out[k] = n;
          }
          return ok(out);
        },
        focus: () => inputs[0]!.focus(),
      };
    }
    default: {
      // String and the ISO 8601 temporal types (checked by the server).
      const text = value === null || value === undefined ? "" : String(value);
      const multi = f.type === "String" && (text.includes("\n") || text.length > 80);
      const input = multi
        ? h("textarea", { rows: 4 }, text)
        : h("input", {
            type: "text",
            value: text,
            placeholder: TEMPORAL_PLACEHOLDER[f.type] ?? "",
          });
      return {
        el: input,
        get: () =>
          f.type !== "String" && input.value.trim() === ""
            ? fail(`Enter a value (e.g. ${TEMPORAL_PLACEHOLDER[f.type] ?? ""}).`)
            : ok(f.type === "String" ? input.value : input.value.trim()),
        focus: () => input.focus(),
      };
    }
  }
}

/** A JSON textarea, validated as you type. */
function jsonEditor(value: unknown, check: (v: unknown) => string | null, pretty = false): Editor {
  const area = h(
    "textarea",
    { rows: pretty ? 6 : 3, spellcheck: "false" },
    value === undefined || value === null ? "" : JSON.stringify(value, null, pretty ? 2 : 0),
  );
  const error = h("div", { class: "error" });
  const read = (): Read => {
    let v: unknown;
    try {
      v = JSON.parse(area.value);
    } catch (e) {
      return fail(`Invalid JSON: ${(e as Error).message}`);
    }
    const problem = check(v);
    return problem ? fail(problem) : ok(v);
  };
  area.addEventListener("input", () => {
    const r = read();
    area.classList.toggle("invalid", !r.ok);
    error.textContent = r.ok ? "" : r.error;
  });
  return { el: h("div", null, area, error), get: read, focus: () => area.focus() };
}

/** Editor of a list field: one row per element, add and remove. */
function listEditor(f: StudioScalarField, value: unknown): Editor {
  const items: { editor: Editor; row: HTMLElement }[] = [];
  const box = h("div", { class: "list-items" });
  const add = (v: unknown) => {
    const editor = scalarEditor({ ...f, list: false }, v);
    const row = h(
      "div",
      { class: "row" },
      editor.el,
      h(
        "button",
        {
          class: "btn small ghost",
          type: "button",
          title: "Remove",
          onclick: () => {
            items.splice(
              items.findIndex((i) => i.row === row),
              1,
            );
            row.remove();
            box.dispatchEvent(new Event("input", { bubbles: true }));
          },
        },
        "✕",
      ),
    );
    items.push({ editor, row });
    box.append(row);
  };
  for (const v of Array.isArray(value) ? value : []) add(v);
  const addBtn = h(
    "button",
    {
      class: "btn small",
      type: "button",
      onclick: () => {
        add(null);
        items[items.length - 1]?.editor.focus();
        box.dispatchEvent(new Event("input", { bubbles: true }));
      },
    },
    "+ Add item",
  );
  return {
    el: h("div", null, box, addBtn),
    get: () => {
      const out: unknown[] = [];
      for (const [i, it] of items.entries()) {
        const r = it.editor.get();
        if (!r.ok) return fail(`Item ${i + 1}: ${r.error}`);
        out.push(r.value);
      }
      return ok(out);
    },
    focus: () => (items[0]?.editor ?? { focus: () => addBtn.focus() }).focus(),
  };
}

/** Editor of a whole field value: lists, vectors, and a "null" switch for optional fields. */
export function fieldEditor(
  f: StudioScalarField,
  value: unknown,
  opts: { nullLabel?: string; startNull?: boolean } = {},
): Editor {
  const inner = f.list && f.type !== "Vector" ? listEditor(f, value) : scalarEditor(f, value);
  const nullable = opts.nullLabel !== undefined;
  if (!nullable) return inner;
  const startNull = opts.startNull ?? (value === null || value === undefined);
  const box = h("input", { type: "checkbox", checked: startNull });
  const sync = () => inner.el.classList.toggle("is-null", box.checked);
  const setDisabled = () => {
    for (const el of inner.el.querySelectorAll("input, select, textarea, button")) {
      (el as HTMLInputElement).disabled = box.checked;
    }
    if (inner.el instanceof HTMLInputElement || inner.el instanceof HTMLSelectElement) {
      inner.el.disabled = box.checked;
    }
  };
  box.addEventListener("change", () => {
    sync();
    setDisabled();
    if (!box.checked) inner.focus();
  });
  sync();
  setDisabled();
  return {
    el: h("div", { class: "row" }, inner.el, h("label", { class: "nullbox" }, box, opts.nullLabel)),
    get: () => (box.checked ? ok(null) : inner.get()),
    focus: () => (box.checked ? box.focus() : inner.focus()),
  };
}

/** `true` for types edited inline in a table cell (one input, no list). */
export function inlineEditable(f: StudioScalarField): boolean {
  return !f.list && !["Json", "Vector", "Point", "CartesianPoint"].includes(f.type);
}
