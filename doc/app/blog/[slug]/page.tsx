import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { importPage } from "nextra/pages";
import { Arrow, Tags } from "../../../components/content/parts";
import styles from "../../../components/content/content.module.css";
import { JsonLd } from "../../../components/seo/json-ld";
import { CONTEXT, ORG_ID } from "../../../components/seo/structured-data";
import { formatDate, getPost, getPosts } from "../../../lib/content";
import { absoluteUrl } from "../../../lib/site";
import { PageWrapper as Wrapper } from "../../../mdx-components";

type Props = { params: Promise<{ slug: string }> };

export const dynamicParams = false;

export function generateStaticParams() {
  return getPosts().map((p) => ({ slug: p.slug }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const post = getPost((await params).slug);
  if (!post) return {};
  return {
    title: post.title,
    description: post.description,
    keywords: post.tags,
    authors: [{ name: post.author }],
    openGraph: {
      type: "article",
      siteName: "Cyphra",
      url: "./",
      locale: "en_US",
      title: post.title,
      description: post.description,
      publishedTime: post.date,
      modifiedTime: post.updated ?? post.date,
      authors: [post.author],
      tags: post.tags,
    },
  };
}

export default async function BlogPost({ params }: Props) {
  const { slug } = await params;
  const post = getPost(slug);
  if (!post) notFound();
  const { default: MDXContent, toc, metadata, sourceCode } = await importPage(["blog", slug]);
  const others = getPosts().filter((p) => p.slug !== slug);
  const url = absoluteUrl(post.path);

  const jsonLd = {
    "@context": CONTEXT,
    "@type": "BlogPosting",
    "@id": `${url}#article`,
    mainEntityOfPage: { "@type": "WebPage", "@id": url },
    url,
    headline: post.title,
    description: post.description,
    image: absoluteUrl(`${post.path}/opengraph-image`),
    datePublished: post.date,
    dateModified: post.updated ?? post.date,
    inLanguage: "en",
    keywords: post.tags.join(", "),
    wordCount: post.body.split(/\s+/).filter(Boolean).length,
    author: { "@type": "Organization", "@id": ORG_ID, name: "Cyphra", url: absoluteUrl("/") },
    publisher: { "@id": ORG_ID },
    isPartOf: { "@type": "Blog", "@id": absoluteUrl("/blog#blog"), url: absoluteUrl("/blog") },
  };

  return (
    <Wrapper toc={toc} metadata={metadata} sourceCode={sourceCode}>
      <header className={styles.entryHead}>
        <Link href="/blog" className={styles.eyebrowLink}>
          <span aria-hidden="true">(→</span>Blog
        </Link>
        <h1 className={styles.entryTitle}>{post.title}</h1>
        <p className={styles.entryLede}>{post.description}</p>
        <p className={styles.meta}>
          <time dateTime={post.date}>{formatDate(post.date)}</time>
          <span>{post.readingMinutes} min read</span>
          <span>{post.author}</span>
        </p>
        <Tags tags={post.tags} />
      </header>

      <MDXContent />

      <footer className={styles.entryFoot}>
        {others.length ? (
          <div className={styles.footBlock}>
            <h2 className={styles.footTitle}>Keep reading</h2>
            <ul className={styles.chips}>
              {others.map((p) => (
                <li key={p.slug}>
                  <Link href={p.path}>
                    {p.title}
                    <Arrow />
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <div className={styles.footBlock}>
          <h2 className={styles.footTitle}>Try it</h2>
          <ul className={styles.chips}>
            <li>
              <Link href="/getting-started">
                Getting started
                <Arrow />
              </Link>
            </li>
            <li>
              <Link href="/glossary">
                Graph database glossary
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
