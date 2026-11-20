import type { Metadata } from "next";
import Link from "next/link";
import { Arrow, Eyebrow } from "../../components/content/parts";
import styles from "../../components/content/content.module.css";
import landing from "../../components/landing/landing.module.css";
import { JsonLd } from "../../components/seo/json-ld";
import { CONTEXT, ORG_ID, WEBSITE_ID } from "../../components/seo/structured-data";
import { getTerms } from "../../lib/content";
import { absoluteUrl } from "../../lib/site";
import { PageWrapper as Wrapper } from "../../mdx-components";

const TITLE = "Neo4j and graph database glossary";
const DESCRIPTION =
  "Short, exact definitions of the terms you meet when building on Neo4j: Cypher, labels, relationship types, Bolt, constraints, indexes, migrations and more.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  openGraph: { type: "website", siteName: "Cyphra", url: "./", locale: "en_US" },
};

export default function GlossaryIndex() {
  const terms = getTerms();
  const jsonLd = {
    "@context": CONTEXT,
    "@type": "DefinedTermSet",
    "@id": absoluteUrl("/glossary#set"),
    url: absoluteUrl("/glossary"),
    name: "Cyphra graph database glossary",
    description: DESCRIPTION,
    inLanguage: "en",
    isPartOf: { "@id": WEBSITE_ID },
    publisher: { "@id": ORG_ID },
    hasDefinedTerm: terms.map((t) => ({
      "@type": "DefinedTerm",
      "@id": absoluteUrl(`${t.path}#term`),
      name: t.title,
      description: t.description,
      url: absoluteUrl(t.path),
    })),
  };

  return (
    <Wrapper
      toc={[]}
      metadata={{ title: "Glossary", filePath: "app/glossary/page.tsx" }}
      sourceCode=""
    >
      <div className={`cy-landing ${landing.root}`}>
        <header className={styles.head}>
          <div className={landing.container}>
            <Eyebrow>Glossary</Eyebrow>
            <h1 className={styles.title}>{TITLE}.</h1>
            <p className={styles.lede}>{DESCRIPTION}</p>
            <div className={styles.headLinks}>
              <Link href="/getting-started">
                <span aria-hidden="true">(→</span>Docs
              </Link>
              <Link href="/blog">
                <span aria-hidden="true">(→</span>Blog
              </Link>
            </div>
          </div>
        </header>

        <section className={styles.body} aria-label="Terms">
          <div className={landing.container}>
            <ul className={styles.terms}>
              {terms.map((t) => (
                <li key={t.slug}>
                  <Link href={t.path} className={styles.termCard}>
                    <h2 className={styles.termName}>
                      {t.title}
                      <Arrow />
                    </h2>
                    <p className={styles.termDesc}>{t.description}</p>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </section>
      </div>
      <JsonLd data={jsonLd} />
    </Wrapper>
  );
}
