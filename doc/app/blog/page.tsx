import type { Metadata } from "next";
import Link from "next/link";
import { Arrow, Eyebrow, Tags } from "../../components/content/parts";
import styles from "../../components/content/content.module.css";
import landing from "../../components/landing/landing.module.css";
import { JsonLd } from "../../components/seo/json-ld";
import { CONTEXT, ORG_ID, WEBSITE_ID } from "../../components/seo/structured-data";
import { formatDate, getPosts } from "../../lib/content";
import { absoluteUrl } from "../../lib/site";
import { PageWrapper as Wrapper } from "../../mdx-components";

const TITLE = "Blog: Neo4j and TypeScript in practice";
const DESCRIPTION =
  "Guides and design notes from the team building Cyphra: typed Neo4j queries in TypeScript, schema migrations, Cypher and the trade-offs behind the OGM.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  openGraph: { type: "website", siteName: "Cyphra", url: "./", locale: "en_US" },
};

export default function BlogIndex() {
  const posts = getPosts();
  const jsonLd = {
    "@context": CONTEXT,
    "@type": "Blog",
    "@id": absoluteUrl("/blog#blog"),
    url: absoluteUrl("/blog"),
    name: "Cyphra blog",
    description: DESCRIPTION,
    inLanguage: "en",
    isPartOf: { "@id": WEBSITE_ID },
    publisher: { "@id": ORG_ID },
    blogPost: posts.map((p) => ({
      "@type": "BlogPosting",
      "@id": absoluteUrl(`${p.path}#article`),
      headline: p.title,
      url: absoluteUrl(p.path),
      datePublished: p.date,
    })),
  };

  return (
    <Wrapper toc={[]} metadata={{ title: "Blog", filePath: "app/blog/page.tsx" }} sourceCode="">
      <div className={`cy-landing ${landing.root}`}>
        <header className={styles.head}>
          <div className={landing.container}>
            <Eyebrow>Blog</Eyebrow>
            <h1 className={styles.title}>Notes on typed graphs.</h1>
            <p className={styles.lede}>{DESCRIPTION}</p>
            <div className={styles.headLinks}>
              <a href="/feed.xml">
                <span aria-hidden="true">(→</span>RSS feed
              </a>
              <Link href="/glossary">
                <span aria-hidden="true">(→</span>Glossary
              </Link>
              <Link href="/getting-started">
                <span aria-hidden="true">(→</span>Docs
              </Link>
            </div>
          </div>
        </header>

        <section className={styles.body} aria-label="Posts">
          <div className={landing.container}>
            <ul className={styles.posts}>
              {posts.map((p) => (
                <li key={p.slug} className={styles.postRow}>
                  <Link href={p.path} className={styles.postLink}>
                    <time className={styles.postDate} dateTime={p.date}>
                      {formatDate(p.date)}
                    </time>
                    <div>
                      <h2 className={styles.postTitle}>{p.title}</h2>
                      <p className={styles.postDesc}>{p.description}</p>
                      <Tags tags={p.tags} />
                    </div>
                    <Arrow className={styles.postArrow} />
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
