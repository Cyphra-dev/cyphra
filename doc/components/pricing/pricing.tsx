import Link from "next/link";
import landing from "../landing/landing.module.css";
import styles from "./pricing.module.css";

const APP_URL = "https://app.cyphra.dev";

// Keep in sync with config/billing.config.ts in the platform.
const PLANS = [
  {
    name: "Free",
    price: "$0",
    period: "/mo",
    desc: "A small database for prototypes and side projects.",
    features: ["1 GB memory", "2 GB storage", "No backups"],
    cta: "Start for free",
  },
  {
    name: "Starter",
    price: "$29",
    period: "/mo",
    desc: "A dedicated instance for a first production app.",
    features: ["2 GB memory", "10 GB storage", "Daily backups"],
    cta: "Choose Starter",
  },
  {
    name: "Pro",
    price: "$99",
    period: "/mo",
    desc: "Production workloads with more headroom.",
    features: ["8 GB memory", "50 GB storage", "Daily backups, 14-day retention"],
    cta: "Choose Pro",
    highlight: true,
  },
  {
    name: "Team",
    price: "Custom",
    period: "",
    desc: "Larger instances and shared workspaces.",
    features: ["16 GB memory", "100 GB storage", "Talk to us about limits"],
    cta: "Contact us",
  },
] as const;

const FAQ: [string, string][] = [
  [
    "Is it Neo4j Community or Enterprise?",
    "Neo4j Community Edition, single server, one dedicated instance per database. Clustering and other Enterprise features are not available.",
  ],
  [
    "Is the price per database?",
    "Yes. Each database has its own plan, and you can move it to a larger plan at any time. Storage grows online and never shrinks.",
  ],
  [
    "How do backups work?",
    "Paid plans take a daily dump stored outside the cluster. Neo4j Community has no online backup, so the database stops for the length of the dump.",
  ],
  [
    "Do I have to use the Cyphra ORM?",
    "No. Databases speak Bolt over TLS (neo4j+s://), so any Neo4j driver or tool works. The Cyphra ORM is free and open source either way.",
  ],
];

function Check() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" fill="none" aria-hidden="true">
      <path d="M3.5 8.5l3 3 6-7" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Pricing() {
  return (
    <div className={landing.root}>
      <section className={styles.head}>
        <div className={landing.container}>
          <p className={landing.eyebrow}>Cyphra Cloud · Early access</p>
          <h1 className={styles.title}>Managed Neo4j, priced per database.</h1>
          <p className={landing.lede}>
            Every database is a dedicated Neo4j Community instance with TLS, generated credentials
            and its own storage. Start free, upgrade when your graph grows.
          </p>
        </div>
      </section>

      <section className={styles.plansSection} aria-label="Plans">
        <div className={landing.container}>
          <div className={styles.plans}>
            {PLANS.map((p) => (
              <article
                key={p.name}
                className={"highlight" in p && p.highlight ? `${styles.plan} ${styles.planHighlight}` : styles.plan}
              >
                <h2 className={styles.planName}>
                  {p.name}
                  {"highlight" in p && p.highlight ? <span className={styles.badge}>Popular</span> : null}
                </h2>
                <p className={styles.planDesc}>{p.desc}</p>
                <p className={styles.price}>
                  {p.price}
                  <span>{p.period}</span>
                </p>
                <ul className={styles.features}>
                  {p.features.map((f) => (
                    <li key={f}>
                      <Check />
                      {f}
                    </li>
                  ))}
                </ul>
                <a
                  href={p.name === "Team" ? "https://github.com/Cyphra-dev/cyphra/issues" : `${APP_URL}/signup`}
                  className={"highlight" in p && p.highlight ? landing.btnPrimary : landing.btnSecondary}
                  data-event="cta_click"
                  data-event-target={p.name.toLowerCase()}
                  data-event-where="pricing"
                >
                  {p.cta}
                </a>
              </article>
            ))}
          </div>
          <p className={styles.note}>
            Prices in USD, per database per month, excluding taxes. Early-access plans and prices may
            change; we will tell you before anything changes for an existing database.
          </p>
        </div>
      </section>

      <section className={landing.section} aria-labelledby="faq-title">
        <div className={landing.container}>
          <header className={landing.sectionHead}>
            <p className={landing.eyebrow}>Questions</p>
            <h2 id="faq-title" className={landing.h2}>
              Before you pick a plan.
            </h2>
          </header>
          <dl className={styles.faq}>
            {FAQ.map(([q, a]) => (
              <div key={q}>
                <dt>{q}</dt>
                <dd>{a}</dd>
              </div>
            ))}
          </dl>
          <p className={styles.more}>
            How databases are created, connected and backed up: <Link href="/cloud">Cyphra Cloud docs</Link>.
          </p>
        </div>
      </section>
    </div>
  );
}
