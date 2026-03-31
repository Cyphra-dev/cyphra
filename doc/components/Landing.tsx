import Link from "next/link";
import styles from "./landing.module.css";

const SITE = "https://www.cyphra.dev";
const GITHUB = "https://github.com/cyphra-dev/cyphra";

const features = [
  {
    icon: "◇",
    title: "Schema DSL",
    href: "/schema",
    description:
      "Declare nodes, relationships, and decorators in `.cyphra` files—constraints and indexes line up with Neo4j 5+ without losing the graph model.",
  },
  {
    icon: "⌁",
    title: "Cypher-first queries",
    href: "/queries",
    description:
      "Tagged `cypher` templates compile to parameterized queries you can audit in code review. Optional builder when you want structure without hiding Cypher.",
  },
  {
    icon: "◎",
    title: "Runtime you control",
    href: "/runtime",
    description:
      "Thin `CyphraClient` over the official driver: sessions, transactions, and `runCompiled` so execution stays predictable in production.",
  },
  {
    icon: "↻",
    title: "Tracked migrations",
    href: "/migrations",
    description:
      "Versioned DDL with `__CyphraMigration` tracking—same discipline as SQL migrators, tuned for constraints, indexes, and graph refactors.",
  },
  {
    icon: "⌘",
    title: "CLI workflow",
    href: "/cli",
    description:
      "From `init` and `validate` to `push` and `migrate`—one toolchain from schema edits to applied database state.",
  },
  {
    icon: "◈",
    title: "One install",
    href: "/example",
    description:
      "The `cyphra` package depends on every `@cyphra/*` module plus the CLI—like a central hub. Scoped packages remain available for minimal installs.",
  },
] as const;

export function Landing() {
  return (
    <div className={styles.root}>
      <header className={styles.hero}>
        <div className={styles.heroGrid} aria-hidden />
        <div className={styles.heroInner}>
          <p className={styles.eyebrow}>
            <span className={styles.eyebrowDot} />
            Neo4j · TypeScript
          </p>
          <h1 className={styles.title}>
            Your graph layer, <span className={styles.titleAccent}>fully typed</span>—without losing
            Cypher.
          </h1>
          <p className={styles.subtitle}>
            Cyphra is a TypeScript-first toolkit for Neo4j: a Prisma-inspired schema language, safe
            query compilation, a small runtime, and migrations that stay visible in git and in your
            database.
          </p>
          <div className={styles.ctaRow}>
            <Link href="/introduction" className={styles.ctaPrimary}>
              What is Cyphra?
            </Link>
            <Link href="/getting-started" className={styles.ctaSecondary}>
              Getting started
            </Link>
            <Link href="/example" className={styles.ctaSecondary}>
              Example project
            </Link>
            <a href={SITE} className={styles.ctaSecondary} target="_blank" rel="noreferrer">
              cyphra.dev
            </a>
            <a href={GITHUB} className={styles.ctaSecondary} target="_blank" rel="noreferrer">
              GitHub
            </a>
          </div>
        </div>
      </header>

      <p className={styles.sectionTitle}>Why teams pick Cyphra</p>
      <div className={styles.pillRow}>
        <span className={styles.pill}>Cypher stays in the open</span>
        <span className={styles.pill}>Graph model stays first-class</span>
        <span className={styles.pill}>Parameters & injection safety</span>
        <span className={styles.pill}>Reviewable schema & DDL</span>
        <span className={styles.pill}>Monorepo-friendly packages</span>
      </div>

      <p className={styles.sectionTitle}>What you get</p>
      <div className={styles.grid}>
        {features.map((f) => (
          <article key={f.href} className={styles.card}>
            <div className={styles.cardIcon} aria-hidden>
              {f.icon}
            </div>
            <h2 className={styles.cardTitle}>
              <Link href={f.href}>{f.title}</Link>
            </h2>
            <p className={styles.cardDesc}>{f.description}</p>
          </article>
        ))}
      </div>

      <div className={styles.split}>
        <div className={styles.splitProse}>
          <h2>Designed for real workflows</h2>
          <ul>
            <li>
              <strong className={styles.splitStrong}>Diff-friendly schema</strong> — canonical print
              output for reviews; comments are not silently round-tripped.
            </li>
            <li>
              <strong className={styles.splitStrong}>Neo4j-aligned constraints</strong> —
              uniqueness, range indexes, and relationship property rules mapped from decorators.
            </li>
            <li>
              <strong className={styles.splitStrong}>Progressive adoption</strong> — use only
              schema, only queries, or the full stack; packages split cleanly when you need them.
            </li>
          </ul>
        </div>
        <div>
          <div className={styles.codeWrap}>
            <div className={styles.codeBar} aria-hidden>
              <span className={styles.codeDot} style={{ background: "#f87171" }} />
              <span className={styles.codeDot} style={{ background: "#fbbf24" }} />
              <span className={styles.codeDot} style={{ background: "#4ade80" }} />
            </div>
            <pre className={styles.codePre}>
              <code>
                <span className="kw">import</span> {"{ cypher, CyphraClient } "}
                <span className="kw">from</span> <span className="str">&quot;cyphra&quot;</span>;
                {"\n\n"}
                <span className="kw">const</span> client = <span className="kw">new</span>{" "}
                <span className="fn">CyphraClient</span>({"{"}
                {"\n  "}
                uri: process.env.<span className="fn">NEO4J_URI</span>!,
                {"\n  "}
                user: process.env.<span className="fn">NEO4J_USER</span>!,
                {"\n  "}
                password: process.env.<span className="fn">NEO4J_PASSWORD</span>!,
                {"\n}"});
                {"\n\n"}
                <span className="kw">await</span> client.<span className="fn">withSession</span>(
                <span className="kw">async</span> (session) =&gt; {"{"}
                {"\n  "}
                <span className="kw">await</span> client.<span className="fn">runCompiled</span>
                (session, cypher
                <span className="str">{`\`RETURN 1 AS n\``}</span>);
                {"\n}"});
                {"\n\n"}
                <span className="kw">await</span> client.<span className="fn">close</span>();
              </code>
            </pre>
          </div>
        </div>
      </div>

      <div className={styles.installBlock}>
        <p className={styles.installLabel}>Install</p>
        <div className={styles.installCmd}>pnpm add cyphra</div>
        <p className={styles.installNote}>
          Includes <code>@cyphra/schema</code>, <code>@cyphra/query</code>,{" "}
          <code>@cyphra/runtime</code>, <code>@cyphra/migrator</code>, and <code>@cyphra/cli</code>{" "}
          (the <code>cyphra</code> binary). Use scoped packages only if you want a minimal
          dependency tree.
        </p>
      </div>

      <p className={styles.footerNote}>
        MIT · Documentation lives alongside the{" "}
        <a href={`${GITHUB}/tree/main/doc`} target="_blank" rel="noreferrer">
          monorepo source
        </a>
        .
      </p>
    </div>
  );
}
