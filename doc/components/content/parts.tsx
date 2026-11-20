import type { ReactNode } from "react";
import styles from "./content.module.css";

export function Arrow({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      aria-hidden="true"
      className={className}
      fill="none"
    >
      <path
        d="M2.5 8h10.5M9 3.5 13.5 8 9 12.5"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Mono, uppercase label that starts with the mark as a bullet. */
export function Eyebrow({ children }: { children: ReactNode }) {
  return (
    <p className={styles.eyebrow}>
      <span aria-hidden="true">(→</span>
      {children}
    </p>
  );
}

export function Tags({ tags, label = "Tags" }: { tags: string[]; label?: string }) {
  if (!tags.length) return null;
  return (
    <ul className={styles.tags} aria-label={label}>
      {tags.map((t) => (
        <li key={t} className={styles.tag}>
          {t}
        </li>
      ))}
    </ul>
  );
}
