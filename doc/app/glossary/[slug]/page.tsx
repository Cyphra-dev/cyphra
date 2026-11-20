import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { importPage } from "nextra/pages";
import { Arrow } from "../../../components/content/parts";
import styles from "../../../components/content/content.module.css";
import { JsonLd } from "../../../components/seo/json-ld";
import { CONTEXT } from "../../../components/seo/structured-data";
import { getTerm, getTerms } from "../../../lib/content";
import { absoluteUrl } from "../../../lib/site";
import { PageWrapper as Wrapper } from "../../../mdx-components";

type Props = { params: Promise<{ slug: string }> };

export const dynamicParams = false;

export function generateStaticParams() {
  return getTerms().map((t) => ({ slug: t.slug }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const term = getTerm((await params).slug);
  if (!term) return {};
  return {
    title: `${term.title}: definition`,
    description: term.description,
    openGraph: {
      type: "article",
      siteName: "Cyphra",
      url: "./",
      locale: "en_US",
      title: `${term.title}: definition`,
      description: term.description,
    },
  };
}

export default async function GlossaryTerm({ params }: Props) {
  const { slug } = await params;
  const term = getTerm(slug);
  if (!term) notFound();
  const { default: MDXContent, toc, metadata, sourceCode } = await importPage(["glossary", slug]);
  const related = term.related
    .map((s) => getTerm(s))
    .filter((t): t is NonNullable<typeof t> => Boolean(t));
  const url = absoluteUrl(term.path);

  const jsonLd = {
    "@context": CONTEXT,
    "@type": "DefinedTerm",
    "@id": `${url}#term`,
    url,
    name: term.title,
    ...(term.aliases.length ? { alternateName: term.aliases } : {}),
    description: term.description,
    inLanguage: "en",
    inDefinedTermSet: {
      "@type": "DefinedTermSet",
      "@id": absoluteUrl("/glossary#set"),
      name: "Cyphra graph database glossary",
      url: absoluteUrl("/glossary"),
    },
  };

  return (
    <Wrapper toc={toc} metadata={metadata} sourceCode={sourceCode}>
      <header className={styles.entryHead}>
        <Link href="/glossary" className={styles.eyebrowLink}>
          <span aria-hidden="true">(→</span>Glossary
        </Link>
        <h1 className={styles.entryTitle}>{term.title}</h1>
        <p className={styles.entryLede}>{term.description}</p>
        {term.aliases.length ? (
          <p className={styles.meta}>
            <span>Also: {term.aliases.join(", ")}</span>
          </p>
        ) : null}
      </header>

      <MDXContent />

      <footer className={styles.entryFoot}>
        {related.length ? (
          <div className={styles.footBlock}>
            <h2 className={styles.footTitle}>Related terms</h2>
            <ul className={styles.chips}>
              {related.map((t) => (
                <li key={t.slug}>
                  <Link href={t.path}>
                    {t.title}
                    <Arrow />
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <div className={styles.footBlock}>
          <h2 className={styles.footTitle}>More</h2>
          <ul className={styles.chips}>
            <li>
              <Link href="/glossary">
                All terms
                <Arrow />
              </Link>
            </li>
            <li>
              <Link href="/getting-started">
                Getting started with Cyphra
                <Arrow />
              </Link>
            </li>
          </ul>
        </div>
      </footer>
      <JsonLd data={jsonLd} />
    </Wrapper>
  );
}
