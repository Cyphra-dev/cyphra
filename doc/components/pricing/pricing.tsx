import Link from "next/link";
import landing from "../landing/landing.module.css";
import { LINKS } from "../links";
import { FAQ, INCLUDED, PLANS } from "./plans";
import styles from "./pricing.module.css";

function Check() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" aria-hidden="true">
      <path
        d="M3.5 8.5l3 3 6-7"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function Pricing() {
  return (
    <div className={`cy-landing ${landing.root}`}>
      <section className={styles.head}>
        <div className={landing.container}>
          <p className={landing.eyebrow}>
            <span aria-hidden="true">(→</span>Cyphra Cloud · Early access
          </p>
          <h1 className={styles.title}>Managed Neo4j, priced per database.</h1>
          <p className={`${landing.lede} ${styles.lede}`}>
            Every database is a dedicated Neo4j Community instance with TLS, generated credentials
            and its own storage. Start free, upgrade when your graph grows.
          </p>
        </div>
      </section>

      <section className={styles.plansSection} aria-label="Plans">
        <div className={landing.container}>
          <div className={styles.plans}>
            {PLANS.map((p) => {
              const hl = "highlight" in p && p.highlight;
              return (
                <article key={p.name} className={hl ? `${styles.plan} ${styles.hl}` : styles.plan}>
                  <h2 className={styles.planName}>
                    {p.name}
                    {hl ? <span className={styles.badge}>Popular</span> : null}
                  </h2>
                  <p className={styles.price}>
                    {p.price}
                    {p.period ? <span>{p.period}</span> : null}
                  </p>
                  <p className={styles.planDesc}>{p.desc}</p>
                  <dl className={styles.specs}>
                    {Object.entries(p.specs).map(([k, v]) => (
                      <div key={k}>
                        <dt>{k}</dt>
                        <dd>{v}</dd>
                      </div>
                    ))}
                  </dl>
                  <a
                    href={p.href}
                    className={`${hl ? landing.btnPrimary : landing.btnSecondary} ${styles.cta}`}
                    data-event="cta_click"
                    data-event-target={p.name.toLowerCase()}
                    data-event-where="pricing"
                  >
                    {p.cta}
                  </a>
                </article>
              );
            })}
          </div>

          <div className={styles.included}>
            <h2 className={styles.includedTitle}>Every plan includes</h2>
            <ul>
              {INCLUDED.map((f) => (
                <li key={f}>
                  <Check />
                  {f}
                </li>
              ))}
            </ul>
          </div>

          <p className={styles.note}>
            Prices in USD, per database per month, excluding taxes. Early-access plans and prices
            may change; we will tell you before anything changes for an existing database.
          </p>
        </div>
      </section>

      <section className={landing.section} aria-labelledby="faq-title">
        <div className={`${landing.container} ${styles.faqWrap}`}>
          <header>
            <p className={landing.eyebrow}>
              <span aria-hidden="true">(→</span>Questions
            </p>
            <h2 id="faq-title" className={landing.h2}>
              Before you pick a plan.
            </h2>
            <p className={landing.sectionLede}>
              How databases are created, connected and backed up is in the{" "}
              <Link href="/cloud" className={landing.inlineLink}>
                Cyphra Cloud docs
              </Link>
              .
            </p>
          </header>
          <div className={styles.faq}>
            {FAQ.map(([q, a], i) => (
              <details key={q} open={i === 0}>
                <summary>{q}</summary>
                <p>{a}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      <section className={landing.final}>
        <div className={landing.container}>
          <h2 className={landing.finalTitle}>Rather run it yourself?</h2>
          <p className={landing.sectionLede}>
            Cyphra Cloud runs on the open-source Cyphra Operator. Use it on your own Kubernetes.
          </p>
          <div className={`${landing.ctaRow} ${landing.ctaCenter}`}>
            <a
              href={LINKS.operator}
              className={landing.btnSecondary}
              data-event="cta_click"
              data-event-target="operator"
              data-event-where="pricing"
            >
              Cyphra Operator on GitHub
            </a>
            <Link href="/getting-started" className={landing.btnGhost}>
              Read the ORM docs
            </Link>
          </div>
        </div>
      </section>
    </div>
  );
}
