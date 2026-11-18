"use client";

import { useEffect, useState } from "react";
import styles from "./landing.module.css";

type Props = { command: string; className?: string };

/** A shell command with a copy button, e.g. `$ npm i cyphra`. */
export function CopyCommand({ command, className }: Props) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(t);
  }, [copied]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
    } catch {
      // Clipboard access can be denied (insecure context, permissions); the text stays selectable.
    }
  }

  return (
    <div className={`${styles.command} ${className ?? ""}`}>
      <code>
        <span className={styles.prompt} aria-hidden="true">
          $
        </span>
        {command}
      </code>
      <button
        type="button"
        onClick={copy}
        className={styles.copy}
        aria-label={copied ? "Copied" : `Copy command: ${command}`}
        data-copied={copied || undefined}
      >
        {copied ? (
          <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
            <path
              d="M3.5 8.5l3 3 6-7"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        ) : (
          <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
            <rect
              x="5.25"
              y="5.25"
              width="8"
              height="8"
              rx="1.75"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.4"
            />
            <path
              d="M10.75 3.25v-.5A1.5 1.5 0 0 0 9.25 1.25h-6.5a1.5 1.5 0 0 0-1.5 1.5v6.5a1.5 1.5 0 0 0 1.5 1.5h.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.4"
            />
          </svg>
        )}
      </button>
      <span className={styles.srOnly} aria-live="polite">
        {copied ? "Copied to clipboard" : ""}
      </span>
    </div>
  );
}
