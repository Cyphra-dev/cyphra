/** Minimal DOM helpers for the studio UI (no framework). */

type Child = Node | string | number | null | undefined | false | Child[];
type Attrs = Record<string, unknown> & {
  class?: string;
  style?: string;
};

/** Create an element: `h("button", { class: "btn", onclick }, "Save")`. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs | null = null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k.startsWith("on") && typeof v === "function") {
        el.addEventListener(k.slice(2), v as EventListener);
      } else if (k === "value" && "value" in el) {
        (el as HTMLInputElement).value = String(v);
      } else if (k === "checked" || k === "disabled" || k === "selected") {
        (el as unknown as Record<string, boolean>)[k] = Boolean(v);
      } else {
        el.setAttribute(k, v === true ? "" : String(v));
      }
    }
  }
  append(el, children);
  return el;
}

function append(el: Element, children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

/** Replace the children of `el`. */
export function mount(el: Element, ...children: Child[]): void {
  el.replaceChildren();
  append(el, children);
}

/** SVG of the Cyphra mark (the `(` of a node and an outgoing arrow). */
export function logoMark(): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 32 32");
  svg.setAttribute("fill", "none");
  svg.setAttribute("aria-hidden", "true");
  const paths: [string, string][] = [
    ["M10 5C4.5 9 4.5 23 10 27", "currentColor"],
    ["M12.5 16H25", "currentColor"],
    ["M20 10.5 25.5 16 20 21.5", "var(--cy-signal)"],
  ];
  for (const [d, stroke] of paths) {
    const p = document.createElementNS(ns, "path");
    p.setAttribute("d", d);
    p.setAttribute("stroke", stroke);
    p.setAttribute("stroke-width", "3.4");
    p.setAttribute("stroke-linecap", "round");
    p.setAttribute("stroke-linejoin", "round");
    svg.append(p);
  }
  return svg;
}
