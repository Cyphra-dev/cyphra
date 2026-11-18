import Link from "next/link";
import { LINKS } from "./links";
import { Logo } from "./logo";

const COLUMNS: { title: string; links: [string, string][] }[] = [
  {
    title: "Docs",
    links: [
      ["Getting started", "/getting-started"],
      ["Schema", "/schema"],
      ["Typed client", "/client"],
      ["Migrations", "/migrations"],
      ["CLI", "/cli"],
    ],
  },
  {
    title: "Project",
    links: [
      ["GitHub", LINKS.github],
      ["Changelog", LINKS.changelog],
      ["Issues", LINKS.issues],
      ["Security", LINKS.security],
    ],
  },
  {
    title: "Packages",
    links: [
      ["cyphra on npm", LINKS.npm],
      ["@cyphra/cli on npm", LINKS.cli],
      ["Kubernetes operator", LINKS.operator],
    ],
  },
];

export function SiteFooter() {
  return (
    <div className="cy-footer">
      <div className="cy-footer-brand">
        <Link href="/" aria-label="Cyphra home">
          <Logo />
        </Link>
        <p>The typed ORM for Neo4j. Schema, client, migrations and CLI for TypeScript.</p>
      </div>
      {COLUMNS.map((col) => (
        <nav key={col.title} aria-label={col.title}>
          <h2>{col.title}</h2>
          <ul>
            {col.links.map(([label, href]) => (
              <li key={href}>
                {href.startsWith("/") ? (
                  <Link href={href}>{label}</Link>
                ) : (
                  <a href={href}>{label}</a>
                )}
              </li>
            ))}
          </ul>
        </nav>
      ))}
      <div className="cy-footer-legal">
        <span>
          © {new Date().getFullYear()} Cyphra. Released under the{" "}
          <a href={LINKS.license}>MIT License</a>.
        </span>
        <span>Neo4j is a trademark of Neo4j, Inc. Cyphra is not affiliated with Neo4j, Inc.</span>
      </div>
    </div>
  );
}
