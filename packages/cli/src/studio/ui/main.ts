/** Cyphra Studio UI: models in the sidebar, a table per model, a record drawer, raw Cypher. */

import type {
  ApiError,
  CypherResponse,
  DeletePreview,
  EdgeFindResponse,
  EdgeRow,
  FindResponse,
  StudioField,
  StudioMeta,
  StudioNodeModel,
  StudioRelationField,
  StudioRelationshipModel,
  StudioScalarField,
} from "../protocol.js";
import { STUDIO_HEADER } from "../protocol.js";
import { h, logoMark, mount } from "./dom.js";
import { fieldEditor, inlineEditable, scalarEditor, typeLabel, type Editor } from "./inputs.js";

type AnyRecord = Record<string, unknown>;

// ---------------------------------------------------------------------------------------------
// API

class ApiFailure extends Error {
  constructor(
    readonly status: number,
    readonly body: ApiError,
  ) {
    super(body.error);
  }
}

async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      [STUDIO_HEADER]: "1",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: "same-origin",
  });
  const data = (await res.json().catch(() => ({ error: res.statusText }))) as unknown;
  if (!res.ok) throw new ApiFailure(res.status, data as ApiError);
  return data as T;
}

// ---------------------------------------------------------------------------------------------
// State

type Sort = { field: string; dir: "asc" | "desc" } | null;

type Condition = { field: string; op: string; editor: Editor | null; raw?: string };

type Parent = {
  model: string;
  where: AnyRecord;
  label: string;
  relation: StudioRelationField;
};

type TableView = {
  kind: "table";
  /** Model of the rows. */
  model: string;
  /** Set when following a relation of a record. */
  parent?: Parent;
  conditions: Condition[];
  showFilters: boolean;
  sort: Sort;
  skip: number;
  take: number;
  rows: AnyRecord[];
  total: number;
  loading: boolean;
};

type EdgeView = {
  kind: "edge";
  name: string;
  sort: Sort;
  skip: number;
  take: number;
  rows: EdgeRow[];
  total: number;
  loading: boolean;
};

type CypherView = {
  kind: "cypher";
  query: string;
  params: string;
  write: boolean;
  result: CypherResponse | null;
  running: boolean;
  ms: number | null;
};

type View = TableView | EdgeView | CypherView | { kind: "home" };

const state: {
  meta: StudioMeta | null;
  counts: Record<string, number>;
  /** Views from the sidebar item to the current one (following relations pushes). */
  stack: View[];
  error: ApiError | null;
  fatal: string | null;
} = { meta: null, counts: {}, stack: [{ kind: "home" }], error: null, fatal: null };

const cypherDraft: CypherView = {
  kind: "cypher",
  query: "MATCH (n) RETURN labels(n) AS labels, count(*) AS nodes ORDER BY nodes DESC",
  params: "",
  write: false,
  result: null,
  running: false,
  ms: null,
};

const view = (): View => state.stack[state.stack.length - 1]!;
const meta = (): StudioMeta => state.meta!;
const nodeModel = (name: string): StudioNodeModel => meta().nodes.find((n) => n.name === name)!;
const relModel = (name: string): StudioRelationshipModel =>
  meta().relationships.find((r) => r.name === name)!;
const scalars = (n: { fields: readonly StudioField[] }): StudioScalarField[] =>
  n.fields.filter((f): f is StudioScalarField => f.kind === "scalar");
const relations = (n: StudioNodeModel): StudioRelationField[] =>
  n.fields.filter((f): f is StudioRelationField => f.kind === "relation");

// ---------------------------------------------------------------------------------------------
// Values

function fmtValue(f: StudioScalarField | undefined, v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (f?.type === "Date" && typeof v === "string") return v.slice(0, 10);
  if (f?.type === "DateTime" && typeof v === "string") return v.replace(/\.000Z$/, "Z");
  if (f?.type === "Vector" && Array.isArray(v)) {
    const head = v.slice(0, 3).map((x) => (typeof x === "number" ? +x.toFixed(4) : x));
    return `[${head.join(", ")}${v.length > 3 ? ", …" : ""}] (${v.length})`;
  }
  if ((f?.type === "Point" || f?.type === "CartesianPoint") && typeof v === "object") {
    return `(${Object.values(v as AnyRecord).join(", ")})`;
  }
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function valueCell(f: StudioScalarField | undefined, v: unknown): Node {
  if (v === null || v === undefined) return h("span", { class: "null" }, "null");
  const text = fmtValue(f, v);
  const numeric = f && ["Int", "Float", "BigInt"].includes(f.type) && !f.list;
  return h("span", { class: numeric ? "num" : f?.type === "Json" ? "mono" : undefined }, text);
}

/** `where` addressing `row` of `model`, or `null` when the model has no key. */
function keyWhere(model: StudioNodeModel, row: AnyRecord): AnyRecord | null {
  const key = model.key;
  if (!key) return null;
  if (key.kind === "field") {
    return row[key.field] === undefined ? null : { [key.field]: row[key.field] };
  }
  return { [key.key]: Object.fromEntries(key.fields.map((f) => [f, row[f]])) };
}

function keyText(model: StudioNodeModel, row: AnyRecord): string {
  const key = model.key;
  if (!key) return "";
  const fields = key.kind === "field" ? [key.field] : key.fields;
  return fields.map((f) => fmtValue(undefined, row[f])).join(" · ");
}

/** Model a row really belongs to (its `__typename` on interface queries). */
function rowModel(model: StudioNodeModel, row: AnyRecord): StudioNodeModel {
  const t = row.__typename;
  return typeof t === "string" && t !== model.name ? (nodeModel(t) ?? model) : model;
}

// ---------------------------------------------------------------------------------------------
// Feedback

let toastTimer: number | undefined;
function toast(text: string): void {
  document.querySelector(".toast")?.remove();
  const el = h("div", { class: "toast", role: "status" }, text);
  document.body.append(el);
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el.remove(), 2200);
}

function errorOf(e: unknown): ApiError {
  if (e instanceof ApiFailure) return e.body;
  return { error: e instanceof Error ? e.message : String(e) };
}

function banner(err: ApiError | null): Node | null {
  if (!err) return null;
  return h(
    "div",
    { class: "banner", role: "alert" },
    err.issues?.length ? "Some values break the schema's validation rules:" : err.error,
    err.issues?.length
      ? h(
          "ul",
          null,
          err.issues.map((i) => h("li", null, `${i.field}: ${i.message}`)),
        )
      : null,
  );
}

// ---------------------------------------------------------------------------------------------
// Data loading

async function loadCounts(): Promise<void> {
  try {
    state.counts = await api<Record<string, number>>("/api/counts");
  } catch {
    // counts are informative only
  }
  renderSide();
}

function whereOf(v: TableView): AnyRecord | undefined {
  const model = nodeModel(v.model);
  const parts: AnyRecord[] = [];
  for (const c of v.conditions) {
    const p = conditionWhere(model, c);
    if (p) parts.push(p);
  }
  return parts.length ? { AND: parts } : undefined;
}

async function loadTable(v: TableView): Promise<void> {
  v.loading = true;
  render();
  try {
    const orderBy = v.sort ? { [v.sort.field]: v.sort.dir } : undefined;
    const res = v.parent
      ? await api<FindResponse>(`/api/models/${encodeURIComponent(v.parent.model)}/related`, {
          where: v.parent.where,
          relation: v.parent.relation.name,
          orderBy,
          skip: v.skip,
          take: v.take,
        })
      : await api<FindResponse>(`/api/models/${encodeURIComponent(v.model)}/find`, {
          where: whereOf(v),
          orderBy,
          skip: v.skip,
          take: v.take,
        });
    v.rows = res.rows as AnyRecord[];
    v.total = res.total;
    state.error = null;
  } catch (e) {
    state.error = errorOf(e);
    if (e instanceof ApiFailure && e.status === 401) state.fatal = e.body.error;
  } finally {
    v.loading = false;
  }
  render();
}

async function loadEdges(v: EdgeView): Promise<void> {
  v.loading = true;
  render();
  try {
    const res = await api<EdgeFindResponse>(
      `/api/relationships/${encodeURIComponent(v.name)}/find`,
      {
        orderBy: v.sort ? { [v.sort.field]: v.sort.dir } : undefined,
        skip: v.skip,
        take: v.take,
      },
    );
    v.rows = [...res.rows];
    v.total = res.total;
    state.error = null;
  } catch (e) {
    state.error = errorOf(e);
  } finally {
    v.loading = false;
  }
  render();
}

function reload(): void {
  const v = view();
  if (v.kind === "table") void loadTable(v);
  else if (v.kind === "edge") void loadEdges(v);
}

// ---------------------------------------------------------------------------------------------
// Navigation

function tableView(model: string, parent?: Parent): TableView {
  return {
    kind: "table",
    model,
    parent,
    conditions: [],
    showFilters: false,
    sort: null,
    skip: 0,
    take: 50,
    rows: [],
    total: 0,
    loading: true,
  };
}

function openRoot(next: View, hash: string): void {
  state.stack = [next];
  state.error = null;
  closeDrawer();
  if (location.hash !== hash) history.replaceState(null, "", hash);
  render();
  reload();
}

function openModel(name: string): void {
  openRoot(tableView(name), `#/model/${encodeURIComponent(name)}`);
}

function openEdges(name: string): void {
  openRoot(
    {
      kind: "edge",
      name,
      sort: null,
      skip: 0,
      take: 50,
      rows: [],
      total: 0,
      loading: true,
    },
    `#/edge/${encodeURIComponent(name)}`,
  );
}

function openCypher(): void {
  openRoot(cypherDraft, "#/cypher");
}

/** Follow `relation` of `row` (of `model`): the related records in a new table. */
function follow(model: StudioNodeModel, row: AnyRecord, relation: StudioRelationField): void {
  const owner = rowModel(model, row);
  const where = keyWhere(owner, row);
  if (!where) {
    toast(`${owner.name} has no @id or @unique field: its relations cannot be opened.`);
    return;
  }
  closeDrawer();
  state.error = null;
  state.stack.push(
    tableView(relation.target, {
      model: owner.name,
      where,
      label: keyText(owner, row),
      relation,
    }),
  );
  reload();
}

function back(depth: number): void {
  state.stack = state.stack.slice(0, depth + 1);
  state.error = null;
  closeDrawer();
  reload();
  render();
}

function route(): void {
  const m = /^#\/(model|edge|cypher)(?:\/(.+))?$/.exec(location.hash);
  const name = m?.[2] ? decodeURIComponent(m[2]) : "";
  if (m?.[1] === "model" && meta().nodes.some((n) => n.name === name)) openModel(name);
  else if (m?.[1] === "edge" && meta().relationships.some((r) => r.name === name)) openEdges(name);
  else if (m?.[1] === "cypher") openCypher();
  else if (meta().nodes[0])
    openModel(meta().nodes.find((n) => !n.abstract)?.name ?? meta().nodes[0].name);
  else render();
}

// ---------------------------------------------------------------------------------------------
// Layout

const root = document.getElementById("app")!;
const top = h("header", { class: "top" });
const side = h("nav", { class: "side", "aria-label": "Models" });
const main = h("main", { class: "main" });
root.append(top, side, main);

const THEMES = ["system", "light", "dark"] as const;
function currentTheme(): (typeof THEMES)[number] {
  const t = document.documentElement.dataset.theme;
  return t === "light" || t === "dark" ? t : "system";
}
function cycleTheme(): void {
  const next = THEMES[(THEMES.indexOf(currentTheme()) + 1) % THEMES.length]!;
  if (next === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = next;
  try {
    if (next === "system") localStorage.removeItem("cyphra-studio-theme");
    else localStorage.setItem("cyphra-studio-theme", next);
  } catch {
    // storage blocked: the choice lasts for this page only
  }
  renderTop();
}

function renderTop(): void {
  const m = state.meta;
  mount(
    top,
    h("div", { class: "brand" }, logoMark(), "cyphra", h("span", null, "studio")),
    m
      ? h(
          "span",
          { class: "conn", title: "Database" },
          m.connection,
          m.database ? ` · ${m.database}` : "",
        )
      : null,
    h("div", { class: "spacer" }),
    m?.dialect === "memgraph"
      ? h(
          "span",
          {
            class: "badge",
            title: "Memgraph dialect: features Memgraph lacks are disabled",
          },
          "Memgraph",
        )
      : null,
    m?.readOnly
      ? h("span", { class: "badge signal", title: "Started with --read-only" }, "read-only")
      : null,
    m ? h("span", { class: "badge" }, `v${m.version}`) : null,
    h(
      "button",
      {
        class: "btn small ghost",
        title: "Theme: system, light or dark",
        onclick: cycleTheme,
        "aria-label": `Theme: ${currentTheme()}`,
      },
      currentTheme() === "dark" ? "◐ Dark" : currentTheme() === "light" ? "◑ Light" : "◒ System",
    ),
  );
}

function renderSide(): void {
  if (!state.meta) return;
  const v = state.stack[0];
  const activeModel = v?.kind === "table" ? v.model : null;
  const activeEdge = v?.kind === "edge" ? v.name : null;
  const item = (
    glyph: string,
    name: string,
    active: boolean,
    onclick: () => void,
    count?: number,
  ) =>
    h(
      "button",
      {
        class: `nav${active ? " active" : ""}`,
        onclick,
        "aria-current": active ? "page" : undefined,
      },
      h("span", { class: "glyph" }, glyph),
      h("span", { class: "name" }, name),
      count === undefined ? null : h("span", { class: "count" }, count.toLocaleString()),
    );
  const nodes = meta().nodes.filter((n) => !n.abstract);
  const interfaces = meta().nodes.filter((n) => n.abstract);
  mount(
    side,
    h("h3", null, "Nodes"),
    nodes.map((n) =>
      item("()", n.name, activeModel === n.name, () => openModel(n.name), state.counts[n.name]),
    ),
    interfaces.length ? h("h3", null, "Interfaces") : null,
    interfaces.map((n) =>
      item("◇", n.name, activeModel === n.name, () => openModel(n.name), state.counts[n.name]),
    ),
    meta().relationships.length ? h("h3", null, "Relationships") : null,
    meta().relationships.map((r) =>
      item("→", r.name, activeEdge === r.name, () => openEdges(r.name), state.counts[r.name]),
    ),
    h("h3", null, "Query"),
    item(">_", "Cypher", v?.kind === "cypher", openCypher),
  );
}

function render(): void {
  renderSide();
  if (state.fatal) {
    mount(
      main,
      h(
        "div",
        { class: "welcome" },
        h("h1", null, "Session token required"),
        h("p", null, state.fatal),
        h(
          "p",
          null,
          "Open the full URL printed in the terminal by ",
          h("code", null, "cyphra studio"),
          " (it carries a one-time token).",
        ),
      ),
    );
    return;
  }
  const v = view();
  if (v.kind === "table") renderTable(v);
  else if (v.kind === "edge") renderEdges(v);
  else if (v.kind === "cypher") renderCypher(v);
  else
    mount(
      main,
      h(
        "div",
        { class: "welcome" },
        h("h1", null, "Cyphra Studio"),
        h("p", null, "The schema has no node models yet."),
      ),
    );
}

// ---------------------------------------------------------------------------------------------
// Filters

const ORDERED = new Set([
  "Int",
  "Float",
  "BigInt",
  "String",
  "DateTime",
  "Date",
  "LocalDateTime",
  "LocalTime",
  "Time",
]);

/** Operators offered for a field: `[op, label]`. */
function operatorsFor(f: StudioField): [string, string][] {
  if (f.kind === "relation") {
    return f.many
      ? [
          ["some", "has some"],
          ["none", "has none"],
        ]
      : [
          ["set", "is set"],
          ["unset", "is not set"],
        ];
  }
  const nulls: [string, string][] = [
    ["null", "is null"],
    ["notnull", "is not null"],
  ];
  if (f.list && f.type !== "Vector") {
    return [
      ["has", "has"],
      ["empty", "is empty"],
      ["notempty", "is not empty"],
    ];
  }
  if (["Vector", "Point", "CartesianPoint"].includes(f.type)) return nulls;
  if (f.type === "Json") return [["equals", "equals"], ...nulls];
  const ops: [string, string][] = [
    ["equals", "="],
    ["not", "≠"],
  ];
  if (ORDERED.has(f.type)) {
    ops.push(["gt", ">"], ["gte", "≥"], ["lt", "<"], ["lte", "≤"]);
  }
  if (f.type === "String") {
    ops.push(
      ["contains", "contains"],
      ["startsWith", "starts with"],
      ["endsWith", "ends with"],
      ["containsI", "contains (any case)"],
      ["equalsI", "= (any case)"],
    );
  }
  if (["String", "Int", "Float", "BigInt", "Enum"].includes(f.type))
    ops.push(["in", "in (a, b, …)"]);
  return [...ops, ...nulls];
}

function needsValue(op: string): boolean {
  return !["null", "notnull", "empty", "notempty", "some", "none", "set", "unset"].includes(op);
}

function conditionEditor(f: StudioField, op: string): Editor | null {
  if (f.kind !== "scalar" || !needsValue(op)) return null;
  if (op === "in") {
    const input = h("input", { type: "text", placeholder: "a, b, c" });
    return {
      el: input,
      get: () => {
        const parts = input.value
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        if (!parts.length) return { ok: false, error: "Enter values." };
        if (f.type === "Int" || f.type === "Float") {
          const nums = parts.map(Number);
          return nums.some((n) => !Number.isFinite(n))
            ? { ok: false, error: "Not a number." }
            : { ok: true, value: nums };
        }
        return { ok: true, value: parts };
      },
      focus: () => input.focus(),
    };
  }
  return scalarEditor({ ...f, list: false, optional: false }, null);
}

function conditionWhere(model: StudioNodeModel, c: Condition): AnyRecord | null {
  const f = model.fields.find((x) => x.name === c.field);
  if (!f) return null;
  switch (c.op) {
    case "null":
    case "unset":
      return { [f.name]: null };
    case "notnull":
    case "set":
      return { NOT: { [f.name]: null } };
    case "empty":
      return { [f.name]: { isEmpty: true } };
    case "notempty":
      return { [f.name]: { isEmpty: false } };
    case "some":
    case "none":
      return { [f.name]: { [c.op]: {} } };
  }
  const r = c.editor?.get();
  if (!r?.ok) return null;
  if (c.op === "containsI") return { [f.name]: { contains: r.value, mode: "insensitive" } };
  if (c.op === "equalsI") return { [f.name]: { equals: r.value, mode: "insensitive" } };
  return { [f.name]: { [c.op]: r.value } };
}

function renderFilters(v: TableView): Node {
  const model = nodeModel(v.model);
  // Fields the database cannot store (a Time on Memgraph) hold no values to filter on.
  const filterable = model.fields.filter((x) => x.kind !== "scalar" || !x.unsupported);
  const rows = v.conditions.map((c, i) => {
    const f = filterable.find((x) => x.name === c.field)!;
    const fieldSel = h(
      "select",
      {
        "aria-label": "Field",
        onchange: (e: Event) => {
          const nf = filterable.find((x) => x.name === (e.target as HTMLSelectElement).value)!;
          c.field = nf.name;
          c.op = operatorsFor(nf)[0]![0];
          c.editor = conditionEditor(nf, c.op);
          render();
        },
      },
      filterable.map((x) => h("option", { value: x.name, selected: x.name === c.field }, x.name)),
    );
    const opSel = h(
      "select",
      {
        "aria-label": "Operator",
        onchange: (e: Event) => {
          c.op = (e.target as HTMLSelectElement).value;
          c.editor = conditionEditor(f, c.op);
          render();
        },
      },
      operatorsFor(f).map(([op, label]) =>
        h("option", { value: op, selected: op === c.op }, label),
      ),
    );
    c.editor?.el.addEventListener("keydown", (e) => {
      if ((e as KeyboardEvent).key === "Enter") applyFilters(v);
    });
    return h(
      "div",
      { class: "filter-row" },
      h("span", { class: "join" }, i === 0 ? "where" : "and"),
      fieldSel,
      opSel,
      c.editor?.el ?? null,
      h(
        "button",
        {
          class: "btn small ghost",
          title: "Remove condition",
          onclick: () => {
            v.conditions.splice(i, 1);
            applyFilters(v);
          },
        },
        "✕",
      ),
    );
  });
  return h(
    "div",
    { class: "filters" },
    rows,
    h(
      "div",
      { class: "filter-row" },
      filterable.length === 0
        ? null
        : h(
            "button",
            {
              class: "btn small",
              onclick: () => {
                const f = filterable[0]!;
                const op = operatorsFor(f)[0]![0];
                v.conditions.push({ field: f.name, op, editor: conditionEditor(f, op) });
                render();
              },
            },
            "+ Condition",
          ),
      v.conditions.length
        ? h("button", { class: "btn small primary", onclick: () => applyFilters(v) }, "Apply")
        : null,
      v.conditions.length
        ? h(
            "button",
            {
              class: "btn small ghost",
              onclick: () => {
                v.conditions = [];
                applyFilters(v);
              },
            },
            "Clear",
          )
        : null,
    ),
  );
}

function applyFilters(v: TableView): void {
  for (const c of v.conditions) {
    const r = c.editor?.get();
    if (r && !r.ok) {
      state.error = { error: `${c.field}: ${r.error}` };
      render();
      return;
    }
  }
  v.skip = 0;
  void loadTable(v);
}

// ---------------------------------------------------------------------------------------------
// Table

function sortHeader(
  label: string,
  type: string,
  field: string,
  sortable: boolean,
  sort: Sort,
  onSort: (s: Sort) => void,
): HTMLElement {
  const dir = sort?.field === field ? sort.dir : null;
  return h(
    "th",
    {
      class: sortable ? "sortable" : undefined,
      title: sortable ? "Sort" : undefined,
      "aria-sort": dir ? (dir === "asc" ? "ascending" : "descending") : undefined,
      onclick: sortable
        ? () =>
            onSort(
              dir === null ? { field, dir: "asc" } : dir === "asc" ? { field, dir: "desc" } : null,
            )
        : undefined,
    },
    label,
    dir ? h("span", { class: "dir" }, dir === "asc" ? "↑" : "↓") : null,
    h("span", { class: "type" }, type),
  );
}

const UNSORTABLE = new Set(["Json", "Vector", "Point", "CartesianPoint"]);

function pager(v: { skip: number; take: number; total: number }, load: () => void): Node {
  const from = v.total === 0 ? 0 : v.skip + 1;
  const to = Math.min(v.skip + v.take, v.total);
  return h(
    "div",
    { class: "footer" },
    h(
      "span",
      null,
      `${from.toLocaleString()}–${to.toLocaleString()} of ${v.total.toLocaleString()}`,
    ),
    h("div", { class: "spacer" }),
    h(
      "select",
      {
        "aria-label": "Rows per page",
        onchange: (e: Event) => {
          v.take = Number((e.target as HTMLSelectElement).value);
          v.skip = 0;
          load();
        },
      },
      [25, 50, 100, 200].map((n) =>
        h("option", { value: n, selected: n === v.take }, `${n} / page`),
      ),
    ),
    h(
      "button",
      {
        class: "btn small",
        disabled: v.skip === 0,
        onclick: () => {
          v.skip = Math.max(0, v.skip - v.take);
          load();
        },
      },
      "← Prev",
    ),
    h(
      "button",
      {
        class: "btn small",
        disabled: v.skip + v.take >= v.total,
        onclick: () => {
          v.skip += v.take;
          load();
        },
      },
      "Next →",
    ),
  );
}

function crumbs(): Node | null {
  if (state.stack.length < 2) return null;
  return h(
    "div",
    { class: "crumbs" },
    state.stack.map((s, i) => {
      if (s.kind !== "table") return null;
      const label = s.parent ? `${s.parent.label}.${s.parent.relation.name}` : s.model;
      const last = i === state.stack.length - 1;
      return [
        i > 0 ? h("span", { class: "arrow" }, "→") : null,
        last ? h("span", null, label) : h("button", { onclick: () => back(i) }, label),
      ];
    }),
  );
}

function renderTable(v: TableView): void {
  const model = nodeModel(v.model);
  const ro = meta().readOnly;
  const cols = scalars(model);
  const rels = relations(model);
  const edge = v.parent?.relation.edge ? relModel(v.parent.relation.edge) : null;
  const onSort = (s: Sort) => {
    v.sort = s;
    v.skip = 0;
    void loadTable(v);
  };
  const title = v.parent
    ? `${v.parent.model} ${v.parent.label} → ${v.parent.relation.name}`
    : model.name;
  const toolbar = h(
    "div",
    { class: "toolbar" },
    state.stack.length > 1 ? crumbs() : h("span", { class: "title" }, title),
    model.abstract ? h("span", { class: "badge" }, "interface") : null,
    !model.key
      ? h(
          "span",
          { class: "badge", title: "No @id, @unique or @@unique: rows cannot be edited" },
          "no key",
        )
      : null,
    h("div", { class: "spacer" }),
    v.parent
      ? null
      : h(
          "button",
          {
            class: "btn",
            "aria-expanded": v.showFilters ? "true" : "false",
            onclick: () => {
              v.showFilters = !v.showFilters;
              if (v.showFilters && v.conditions.length === 0) {
                const f = model.fields[0];
                if (f) {
                  const op = operatorsFor(f)[0]![0];
                  v.conditions.push({ field: f.name, op, editor: conditionEditor(f, op) });
                }
              }
              render();
            },
          },
          "Filter",
          v.conditions.length ? h("span", { class: "badge signal" }, v.conditions.length) : null,
        ),
    h("button", { class: "btn", onclick: () => reload(), title: "Reload" }, "↻"),
    !ro && !model.abstract
      ? h("button", { class: "btn primary", onclick: () => openCreate(model) }, "+ Add record")
      : null,
  );

  const head = h(
    "tr",
    null,
    h("th", null, ""),
    model.abstract ? h("th", null, "Type", h("span", { class: "type" }, "__typename")) : null,
    cols.map((f) =>
      sortHeader(f.name, typeLabel(f), f.name, !UNSORTABLE.has(f.type) && !f.list, v.sort, onSort),
    ),
    rels.map((r) =>
      sortHeader(
        r.name,
        `${r.many ? "[" : ""}${r.target}${r.many ? "]" : r.optional ? "?" : ""}`,
        r.name,
        r.many && !v.parent,
        v.sort,
        onSort,
      ),
    ),
    edge
      ? edge.properties.map((p) =>
          h("th", null, `$edge.${p.name}`, h("span", { class: "type" }, typeLabel(p))),
        )
      : null,
  );

  const body = v.rows.map((row) => {
    const owner = rowModel(model, row);
    const editable = !ro && owner.key !== null;
    return h(
      "tr",
      null,
      h(
        "td",
        { class: "rowhead" },
        h(
          "button",
          {
            class: "btn small ghost",
            title: "Open record",
            onclick: () => openRecord(model, row, v),
          },
          "↗",
        ),
      ),
      model.abstract
        ? h("td", null, h("span", { class: "tag" }, String(row.__typename ?? "")))
        : null,
      cols.map((f) => {
        const td = h(
          "td",
          { class: editable && !f.id ? "editable" : undefined },
          valueCell(f, row[f.name]),
        );
        if (editable && !f.id) {
          td.addEventListener("dblclick", () => {
            if (inlineEditable(f)) editCell(td, owner, row, f);
            else openRecord(model, row, v, f.name);
          });
        }
        return td;
      }),
      rels.map((r) => {
        if (r.many) {
          const n = Number((row._count as AnyRecord | undefined)?.[r.name] ?? 0);
          return h(
            "td",
            null,
            h(
              "button",
              { class: "link", onclick: () => follow(model, row, r) },
              `${n.toLocaleString()} →`,
            ),
          );
        }
        const linked = row[r.name] as AnyRecord | null | undefined;
        if (!linked) return h("td", null, h("span", { class: "null" }, "null"));
        return h(
          "td",
          null,
          h(
            "button",
            { class: "link", onclick: () => follow(model, row, r) },
            `${keyText(nodeModel(r.target), linked) || r.target} →`,
          ),
        );
      }),
      edge
        ? edge.properties.map((p) =>
            h("td", null, valueCell(p, (row.$edge as AnyRecord | undefined)?.[p.name])),
          )
        : null,
    );
  });

  mount(
    main,
    toolbar,
    v.showFilters && !v.parent ? renderFilters(v) : null,
    banner(state.error),
    h(
      "div",
      { class: "table-wrap" },
      v.rows.length || v.loading
        ? h("table", { class: "grid" }, h("thead", null, head), h("tbody", null, body))
        : h(
            "div",
            { class: "empty" },
            v.conditions.length ? "No records match." : "No records yet.",
          ),
    ),
    v.parent && !v.parent.relation.many ? null : pager(v, () => void loadTable(v)),
  );
}

function editCell(
  td: HTMLTableCellElement,
  model: StudioNodeModel,
  row: AnyRecord,
  f: StudioScalarField,
): void {
  const editor = f.optional
    ? fieldEditor(f, row[f.name], { nullLabel: "null" })
    : scalarEditor(f, row[f.name]);
  td.classList.add("editing");
  mount(td, editor.el);
  editor.focus();
  let done = false;
  const cancel = () => {
    if (done) return;
    done = true;
    td.classList.remove("editing");
    mount(td, valueCell(f, row[f.name]));
  };
  const save = async () => {
    if (done) return;
    const r = editor.get();
    if (!r.ok) {
      toast(r.error);
      return;
    }
    done = true;
    try {
      const where = keyWhere(model, row)!;
      const res = await api<{ row: AnyRecord }>(
        `/api/models/${encodeURIComponent(model.name)}/update`,
        {
          where,
          data: { [f.name]: r.value },
        },
      );
      row[f.name] = res.row[f.name];
      state.error = null;
      toast(`Saved ${model.name}.${f.name}`);
    } catch (e) {
      state.error = errorOf(e);
    }
    render();
  };
  editor.el.addEventListener("keydown", (e) => {
    const k = (e as KeyboardEvent).key;
    if (k === "Enter") void save();
    if (k === "Escape") cancel();
  });
  editor.el.addEventListener("focusout", (e) => {
    const next = (e as FocusEvent).relatedTarget as Node | null;
    if (next && editor.el.contains(next)) return;
    void save();
  });
}

// ---------------------------------------------------------------------------------------------
// Relationship models

function renderEdges(v: EdgeView): void {
  const rel = relModel(v.name);
  const from = nodeModel(rel.from);
  const to = nodeModel(rel.to);
  const editable =
    !meta().readOnly && rel.via !== undefined && from.key !== null && to.key !== null;
  const onSort = (s: Sort) => {
    v.sort = s;
    v.skip = 0;
    void loadEdges(v);
  };
  mount(
    main,
    h(
      "div",
      { class: "toolbar" },
      h("span", { class: "title" }, rel.name),
      h("span", { class: "badge mono" }, `(:${rel.from})-[:${rel.relType}]->(:${rel.to})`),
      h("div", { class: "spacer" }),
      h("button", { class: "btn", onclick: () => reload(), title: "Reload" }, "↻"),
    ),
    banner(state.error),
    h(
      "div",
      { class: "table-wrap" },
      v.rows.length || v.loading
        ? h(
            "table",
            { class: "grid" },
            h(
              "thead",
              null,
              h(
                "tr",
                null,
                editable ? h("th", null, "") : null,
                h("th", null, "from", h("span", { class: "type" }, rel.from)),
                h("th", null, "to", h("span", { class: "type" }, rel.to)),
                rel.properties.map((p) =>
                  sortHeader(
                    p.name,
                    typeLabel(p),
                    p.name,
                    !UNSORTABLE.has(p.type) && !p.list,
                    v.sort,
                    onSort,
                  ),
                ),
              ),
            ),
            h(
              "tbody",
              null,
              v.rows.map((row) =>
                h(
                  "tr",
                  null,
                  editable
                    ? h(
                        "td",
                        { class: "rowhead" },
                        h(
                          "button",
                          {
                            class: "btn small ghost",
                            title: "Edit edge",
                            onclick: () => openEdge(rel, row),
                          },
                          "↗",
                        ),
                      )
                    : null,
                  h(
                    "td",
                    null,
                    h(
                      "button",
                      { class: "link", onclick: () => openModelFiltered(from, row.from) },
                      keyText(from, row.from) || JSON.stringify(row.from),
                    ),
                  ),
                  h(
                    "td",
                    null,
                    h(
                      "button",
                      { class: "link", onclick: () => openModelFiltered(to, row.to) },
                      keyText(to, row.to) || JSON.stringify(row.to),
                    ),
                  ),
                  rel.properties.map((p) => h("td", null, valueCell(p, row.properties[p.name]))),
                ),
              ),
            ),
          )
        : h("div", { class: "empty" }, "No edges yet."),
    ),
    pager(v, () => void loadEdges(v)),
  );
}

/** Open a model's table filtered on a record key (from an edge row). */
function openModelFiltered(model: StudioNodeModel, keyRow: AnyRecord): void {
  const where = keyWhere(model, keyRow);
  openModel(model.name);
  const v = view();
  if (!where || v.kind !== "table" || model.key?.kind !== "field") return;
  const f = model.fields.find((x) => x.name === (model.key as { field: string }).field)!;
  const editor = conditionEditor(f, "equals");
  if (editor && f.kind === "scalar") {
    const input = editor.el as HTMLInputElement;
    input.value = String(keyRow[f.name] ?? "");
  }
  v.conditions = [{ field: f.name, op: "equals", editor }];
  v.showFilters = true;
  void loadTable(v);
}

// ---------------------------------------------------------------------------------------------
// Record drawer

let drawer: HTMLElement | null = null;

function closeDrawer(): void {
  drawer?.remove();
  drawer = null;
  document.querySelector(".backdrop")?.remove();
  document.querySelector(".dialog")?.remove();
}

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && (drawer || document.querySelector(".dialog"))) closeDrawer();
});

type FormField = { field: StudioScalarField; editor: Editor; error: HTMLElement; dirty: boolean };

function formField(
  f: StudioScalarField,
  value: unknown,
  mode: "create" | "edit",
  readOnly: boolean,
): { el: HTMLElement; form: FormField } {
  const optionalLike = f.optional || (mode === "create" && (f.hasDefault || f.list));
  const nullLabel = optionalLike
    ? mode === "create"
      ? f.hasDefault
        ? "default"
        : f.list
          ? "empty"
          : "null"
      : "null"
    : undefined;
  const editor = fieldEditor(f, value, {
    nullLabel,
    startNull: mode === "create" ? optionalLike : undefined,
  });
  const error = h("div", { class: "error" });
  const form: FormField = { field: f, editor, error, dirty: false };
  editor.el.addEventListener("input", () => (form.dirty = true));
  editor.el.addEventListener("change", () => (form.dirty = true));
  if (readOnly || f.unsupported) {
    for (const el of editor.el.querySelectorAll("input, select, textarea, button")) {
      (el as HTMLInputElement).disabled = true;
    }
  }
  const el = h(
    "div",
    { class: "field" },
    h(
      "label",
      null,
      f.name,
      h("span", { class: "type" }, typeLabel(f)),
      f.id
        ? h("span", { class: "badge" }, "@id")
        : f.unique
          ? h("span", { class: "badge" }, "@unique")
          : null,
    ),
    editor.el,
    f.rules?.length ? h("div", { class: "hint mono" }, f.rules.join(" ")) : null,
    f.type === "DateTime" ? h("div", { class: "hint" }, "UTC") : null,
    f.unsupported ? h("div", { class: "hint" }, f.unsupported) : null,
    f.type === "Duration" && meta().dialect === "memgraph"
      ? h("div", { class: "hint" }, "Memgraph: days, hours, minutes and seconds only")
      : null,
    error,
  );
  return { el, form };
}

function showIssues(forms: FormField[], err: ApiError, box: HTMLElement): void {
  for (const f of forms) f.error.textContent = "";
  const unmatched: string[] = [];
  for (const i of err.issues ?? []) {
    const f = forms.find((x) => x.field.name === i.field);
    if (f) f.error.textContent = i.message;
    else unmatched.push(`${i.field}: ${i.message}`);
  }
  for (const name of err.fields ?? []) {
    const f = forms.find((x) => x.field.name === name);
    if (f) f.error.textContent = "Already used by another record (unique).";
  }
  mount(
    box,
    banner(err.issues?.length && !unmatched.length ? { error: "Some values are not valid." } : err),
  );
}

function openDrawer(title: Node[], body: Node[], footer: Node[]): HTMLElement {
  closeDrawer();
  const backdrop = h("div", { class: "backdrop", onclick: closeDrawer });
  drawer = h(
    "aside",
    { class: "drawer", role: "dialog", "aria-modal": "true" },
    h(
      "header",
      null,
      ...title,
      h("div", { class: "spacer" }),
      h("button", { class: "btn small ghost", onclick: closeDrawer, "aria-label": "Close" }, "✕"),
    ),
    h("div", { class: "body" }, ...body),
    h("footer", null, ...footer),
  );
  document.body.append(backdrop, drawer);
  return drawer;
}

function openRecord(
  listModel: StudioNodeModel,
  row: AnyRecord,
  v: TableView,
  focusField?: string,
): void {
  const model = rowModel(listModel, row);
  const where = keyWhere(model, row);
  const ro = meta().readOnly || !where;
  const errBox = h("div");
  const forms: FormField[] = [];
  const fieldEls = scalars(model).map((f) => {
    const { el, form } = formField(f, row[f.name], "edit", ro || f.id);
    forms.push(form);
    return el;
  });
  const rels = relations(model);
  const relEl = rels.length
    ? h(
        "div",
        { class: "relations" },
        h("h4", null, "Relations"),
        rels.map((r) => {
          const n = r.many
            ? Number((row._count as AnyRecord | undefined)?.[r.name] ?? 0)
            : row[r.name]
              ? 1
              : 0;
          return h(
            "div",
            { class: "rel" },
            h(
              "span",
              null,
              r.name,
              " ",
              h(
                "span",
                { class: "tag mono" },
                `${r.direction === "OUT" ? "-" : "<-"}[:${r.relType}]${r.direction === "OUT" ? "->" : "-"}`,
              ),
              " ",
              r.target,
            ),
            h(
              "button",
              { class: "link", onclick: () => follow(model, row, r) },
              `${n.toLocaleString()} →`,
            ),
          );
        }),
      )
    : null;
  const edge = v.parent?.relation.edge ? relModel(v.parent.relation.edge) : null;
  const edgeForms: FormField[] = [];
  const edgeEl =
    edge && row.$edge
      ? h(
          "div",
          { class: "relations" },
          h("h4", null, `Edge ${edge.name}`),
          edge.properties.map((p) => {
            const canEdit =
              !meta().readOnly && edge.via !== undefined && v.parent!.relation.direction === "OUT";
            const { el, form } = formField(p, (row.$edge as AnyRecord)[p.name], "edit", !canEdit);
            edgeForms.push(form);
            return el;
          }),
        )
      : null;

  const save = async () => {
    const data: AnyRecord = {};
    let bad = false;
    for (const f of forms.filter((x) => x.dirty)) {
      const r = f.editor.get();
      f.error.textContent = r.ok ? "" : r.error;
      if (r.ok) data[f.field.name] = r.value;
      else bad = true;
    }
    const edgeData: AnyRecord = {};
    for (const f of edgeForms.filter((x) => x.dirty)) {
      const r = f.editor.get();
      f.error.textContent = r.ok ? "" : r.error;
      if (r.ok) edgeData[f.field.name] = r.value;
      else bad = true;
    }
    if (bad) return;
    try {
      if (Object.keys(data).length) {
        const res = await api<{ row: AnyRecord }>(
          `/api/models/${encodeURIComponent(model.name)}/update`,
          {
            where,
            data,
          },
        );
        Object.assign(row, res.row);
      }
      if (Object.keys(edgeData).length && edge && v.parent) {
        await api(`/api/relationships/${encodeURIComponent(edge.name)}/update`, {
          from: v.parent.where,
          to: where,
          data: edgeData,
        });
      }
      closeDrawer();
      toast(`Saved ${model.name} ${keyText(model, row)}`);
      reload();
    } catch (e) {
      showIssues([...forms, ...edgeForms], errorOf(e), errBox);
    }
  };

  openDrawer(
    [
      h("span", null, model.name),
      h("span", { class: "badge mono" }, keyText(model, row) || "no key"),
    ],
    [errBox, ...fieldEls, edgeEl, relEl].filter((x): x is HTMLElement => x !== null),
    ro
      ? [h("button", { class: "btn", onclick: closeDrawer }, "Close")]
      : [
          h("button", { class: "btn danger", onclick: () => confirmDelete(model, row) }, "Delete…"),
          h("div", { class: "spacer" }),
          h("button", { class: "btn", onclick: closeDrawer }, "Cancel"),
          h("button", { class: "btn primary", onclick: () => void save() }, "Save"),
        ],
  );
  const target = forms.find((f) => f.field.name === focusField) ?? forms.find((f) => !f.field.id);
  target?.editor.focus();
}

function openCreate(model: StudioNodeModel): void {
  const errBox = h("div");
  const forms: FormField[] = [];
  const els = scalars(model).map((f) => {
    const { el, form } = formField(f, f.list ? [] : null, "create", false);
    forms.push(form);
    return el;
  });
  const create = async () => {
    const data: AnyRecord = {};
    let bad = false;
    for (const f of forms) {
      const r = f.editor.get();
      f.error.textContent = r.ok ? "" : r.error;
      if (!r.ok) bad = true;
      // null on a create: leave the field out (its default, or absent).
      else if (r.value !== null) data[f.field.name] = r.value;
    }
    if (bad) return;
    try {
      await api(`/api/models/${encodeURIComponent(model.name)}/create`, { data });
      closeDrawer();
      toast(`Created ${model.name}`);
      reload();
      void loadCounts();
    } catch (e) {
      showIssues(forms, errorOf(e), errBox);
    }
  };
  openDrawer(
    [h("span", null, `New ${model.name}`)],
    [errBox, ...els],
    [
      h("button", { class: "btn", onclick: closeDrawer }, "Cancel"),
      h("button", { class: "btn primary", onclick: () => void create() }, "Create"),
    ],
  );
  forms[0]?.editor.focus();
}

function openEdge(rel: StudioRelationshipModel, row: EdgeRow): void {
  const errBox = h("div");
  const forms: FormField[] = [];
  const els = rel.properties.map((p) => {
    const { el, form } = formField(p, row.properties[p.name], "edit", false);
    forms.push(form);
    return el;
  });
  const save = async () => {
    const data: AnyRecord = {};
    for (const f of forms.filter((x) => x.dirty)) {
      const r = f.editor.get();
      f.error.textContent = r.ok ? "" : r.error;
      if (!r.ok) return;
      data[f.field.name] = r.value;
    }
    try {
      await api(`/api/relationships/${encodeURIComponent(rel.name)}/update`, {
        from: keyWhere(nodeModel(rel.from), row.from),
        to: keyWhere(nodeModel(rel.to), row.to),
        data,
      });
      closeDrawer();
      toast(`Saved ${rel.name}`);
      reload();
    } catch (e) {
      showIssues(forms, errorOf(e), errBox);
    }
  };
  openDrawer(
    [
      h("span", null, rel.name),
      h(
        "span",
        { class: "badge mono" },
        `${keyText(nodeModel(rel.from), row.from)} → ${keyText(nodeModel(rel.to), row.to)}`,
      ),
    ],
    [errBox, ...els],
    [
      h("button", { class: "btn", onclick: closeDrawer }, "Cancel"),
      h("button", { class: "btn primary", onclick: () => void save() }, "Save"),
    ],
  );
}

async function confirmDelete(model: StudioNodeModel, row: AnyRecord): Promise<void> {
  const where = keyWhere(model, row);
  if (!where) return;
  document.querySelector(".dialog")?.remove();
  const body = h("div", { class: "body" }, "Checking what the delete affects…");
  const confirm = h("button", { class: "btn danger solid", disabled: true }, "Delete");
  const dialog = h(
    "div",
    { class: "dialog", role: "alertdialog", "aria-modal": "true" },
    h("header", null, `Delete ${model.name} ${keyText(model, row)}?`),
    body,
    h(
      "footer",
      null,
      h("button", { class: "btn", onclick: () => dialog.remove() }, "Cancel"),
      confirm,
    ),
  );
  document.body.append(dialog);
  try {
    const p = await api<DeletePreview>(
      `/api/models/${encodeURIComponent(model.name)}/delete-preview`,
      {
        where,
      },
    );
    const effects = p.effects.filter((e) => e.count > 0);
    mount(
      body,
      effects.length
        ? h(
            "div",
            null,
            p.blocked
              ? "This record cannot be deleted while restricted relations still link nodes:"
              : "Deleting this record also affects its relations (onDelete rules):",
            h(
              "ul",
              { class: "effects" },
              effects.map((e) =>
                h(
                  "li",
                  null,
                  h("span", null, `${e.relation} → ${e.count.toLocaleString()} ${e.target}`),
                  h(
                    "span",
                    { class: `rule-${e.rule}` },
                    e.rule === "Cascade"
                      ? "deleted too (Cascade)"
                      : e.rule === "Restrict"
                        ? "blocks the delete (Restrict)"
                        : "unlinked (SetNull)",
                  ),
                ),
              ),
            ),
            effects.some((e) => e.rule === "Cascade")
              ? h(
                  "p",
                  { class: "hint" },
                  "Nodes deleted by a cascade apply their own onDelete rules.",
                )
              : null,
          )
        : "Nothing else is linked to this record.",
    );
    confirm.disabled = p.blocked;
  } catch (e) {
    mount(body, banner(errorOf(e)));
    return;
  }
  confirm.addEventListener("click", async () => {
    confirm.disabled = true;
    try {
      await api(`/api/models/${encodeURIComponent(model.name)}/delete`, { where });
      closeDrawer();
      toast(`Deleted ${model.name} ${keyText(model, row)}`);
      reload();
      void loadCounts();
    } catch (e) {
      mount(body, banner(errorOf(e)));
    }
  });
}

// ---------------------------------------------------------------------------------------------
// Raw Cypher

function renderCypher(v: CypherView): void {
  const ro = meta().readOnly;
  const query = h(
    "textarea",
    { class: "query", spellcheck: "false", "aria-label": "Cypher query" },
    v.query,
  );
  const params = h(
    "textarea",
    {
      rows: 2,
      spellcheck: "false",
      placeholder: 'Parameters (JSON), e.g. { "name": "Alice" }',
      "aria-label": "Parameters",
    },
    v.params,
  );
  query.addEventListener("input", () => (v.query = query.value));
  params.addEventListener("input", () => (v.params = params.value));
  const run = async () => {
    let p: unknown = {};
    if (v.params.trim()) {
      try {
        p = JSON.parse(v.params);
      } catch (e) {
        state.error = { error: `Parameters: ${(e as Error).message}` };
        render();
        return;
      }
    }
    v.running = true;
    render();
    const t0 = performance.now();
    try {
      v.result = await api<CypherResponse>("/api/cypher", {
        query: v.query,
        params: p,
        write: v.write,
      });
      v.ms = Math.round(performance.now() - t0);
      state.error = null;
      if (v.write) void loadCounts();
    } catch (e) {
      v.result = null;
      state.error = errorOf(e);
    } finally {
      v.running = false;
    }
    render();
  };
  query.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") void run();
  });
  const res = v.result;
  mount(
    main,
    h(
      "div",
      { class: "toolbar" },
      h("span", { class: "title" }, "Cypher"),
      h("span", { class: "badge" }, v.write ? "write transaction" : "read transaction"),
    ),
    h(
      "div",
      { class: "cypher" },
      query,
      params,
      h(
        "div",
        { class: "row" },
        h(
          "button",
          {
            class: "btn primary",
            disabled: v.running,
            title: "Ctrl+Enter / Cmd+Enter",
            onclick: () => void run(),
          },
          v.running ? "Running…" : "Run",
        ),
        ro
          ? h("span", { class: "hint" }, "Read-only studio: queries run in read transactions.")
          : h(
              "label",
              { class: "check" },
              h("input", {
                type: "checkbox",
                checked: v.write,
                onchange: (e: Event) => {
                  v.write = (e.target as HTMLInputElement).checked;
                  render();
                },
              }),
              "Allow writes",
            ),
        res
          ? h(
              "span",
              { class: "hint" },
              `${res.rows.length.toLocaleString()} rows${res.truncated ? " (truncated)" : ""}${v.ms !== null ? ` · ${v.ms} ms` : ""}`,
            )
          : null,
      ),
    ),
    banner(state.error),
    h(
      "div",
      { class: "table-wrap" },
      res && res.rows.length
        ? h(
            "table",
            { class: "grid" },
            h(
              "thead",
              null,
              h(
                "tr",
                null,
                res.columns.map((c) => h("th", null, c)),
              ),
            ),
            h(
              "tbody",
              null,
              res.rows.map((r) =>
                h(
                  "tr",
                  null,
                  res.columns.map((c) =>
                    h(
                      "td",
                      {
                        class: typeof r[c] === "object" && r[c] !== null ? "json-cell" : undefined,
                        title: fmtValue(undefined, r[c]),
                      },
                      valueCell(undefined, r[c]),
                    ),
                  ),
                ),
              ),
            ),
          )
        : res
          ? h("div", { class: "empty" }, "No rows.")
          : null,
    ),
  );
  query.focus();
}

// ---------------------------------------------------------------------------------------------
// Boot

async function boot(): Promise<void> {
  renderTop();
  try {
    state.meta = await api<StudioMeta>("/api/meta");
  } catch (e) {
    state.fatal = errorOf(e).error;
    state.meta = {
      nodes: [],
      relationships: [],
      readOnly: true,
      connection: "",
      version: "",
      dialect: "neo4j",
    };
    render();
    return;
  }
  document.title = `Cyphra Studio · ${state.meta.connection}`;
  renderTop();
  window.addEventListener("hashchange", route);
  route();
  void loadCounts();
}

void boot();
