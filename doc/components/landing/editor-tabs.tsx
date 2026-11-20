"use client";

import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import styles from "./landing.module.css";

export type EditorFile = {
  name: string;
  content: ReactNode;
  /** The animated file: it stays mounted (only hidden) so it keeps time with the graph. */
  live?: boolean;
};

/**
 * Clickable file tabs for the hero editor. Every panel stays in the DOM: hiding the live file with
 * `display: none` would restart its CSS animation and break the sync with the graph, so inactive
 * panels are made invisible and inert instead.
 */
export function EditorTabs({ files, initial }: { files: EditorFile[]; initial: string }) {
  const [active, setActive] = useState(initial);
  const id = useId();
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  function onKeyDown(e: KeyboardEvent<HTMLButtonElement>, index: number) {
    const last = files.length - 1;
    const next =
      e.key === "ArrowRight"
        ? index === last
          ? 0
          : index + 1
        : e.key === "ArrowLeft"
          ? index === 0
            ? last
            : index - 1
          : e.key === "Home"
            ? 0
            : e.key === "End"
              ? last
              : null;
    if (next === null) return;
    e.preventDefault();
    setActive(files[next].name);
    tabRefs.current[next]?.focus();
  }

  return (
    <>
      <div className={styles.editorTabs} role="tablist" aria-label="Files">
        {files.map((f, i) => {
          const selected = f.name === active;
          return (
            <button
              key={f.name}
              ref={(el) => {
                tabRefs.current[i] = el;
              }}
              type="button"
              role="tab"
              id={`${id}-tab-${i}`}
              aria-selected={selected}
              aria-controls={`${id}-panel-${i}`}
              tabIndex={selected ? 0 : -1}
              className={`${styles.tab} ${selected ? styles.tabActive : ""}`}
              onClick={() => setActive(f.name)}
              onKeyDown={(e) => onKeyDown(e, i)}
            >
              {f.name}
            </button>
          );
        })}
      </div>
      <div className={styles.editorPanels}>
        {files.map((f, i) => {
          const selected = f.name === active;
          return (
            <div
              key={f.name}
              role="tabpanel"
              id={`${id}-panel-${i}`}
              aria-labelledby={`${id}-tab-${i}`}
              aria-hidden={!selected}
              inert={!selected}
              tabIndex={selected && !f.live ? 0 : undefined}
              className={`${f.live ? styles.panelLive : styles.panelStatic} ${
                selected ? "" : styles.panelHidden
              }`}
            >
              {f.content}
            </div>
          );
        })}
      </div>
    </>
  );
}
