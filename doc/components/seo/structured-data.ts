// Schema.org builders for the site's JSON-LD. Every node uses stable `@id`s so pages can reference
// the Organization and WebSite declared once in the root layout. No ratings or reviews: only facts
// that are visible on the site.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LINKS } from "../links";
import { FAQ, PLANS } from "../pricing/plans";
import { SITE, absoluteUrl } from "../../lib/site";

const CONTEXT = "https://schema.org";
export const ORG_ID = `${SITE.url}/#organization`;
export const WEBSITE_ID = `${SITE.url}/#website`;
export const SOFTWARE_ID = `${SITE.url}/#software`;
export const CLOUD_ID = `${SITE.url}/cloud#product`;

const LICENSE_URL = "https://opensource.org/licenses/MIT";

/** Version of the `cyphra` package in this checkout (the one the docs describe). */
function cyphraVersion(): string | undefined {
  try {
    const pkg = JSON.parse(
      readFileSync(join(process.cwd(), "..", "packages", "cyphra", "package.json"), "utf8"),
    ) as { version?: string };
    return pkg.version;
  } catch {
    return undefined;
  }
}

export function organization() {
  return {
    "@type": "Organization",
    "@id": ORG_ID,
    name: SITE.name,
    legalName: SITE.legalName,
    url: SITE.url,
    logo: { "@type": "ImageObject", url: SITE.logo, width: 180, height: 180 },
    sameAs: [...SITE.sameAs],
  };
}

export function website() {
  return {
    "@type": "WebSite",
    "@id": WEBSITE_ID,
    url: SITE.url,
    name: SITE.name,
    description: SITE.description,
    inLanguage: SITE.language,
    publisher: { "@id": ORG_ID },
  };
}

/** Organization + WebSite, rendered once in the root layout. */
export function siteGraph() {
  return { "@context": CONTEXT, "@graph": [organization(), website()] };
}

export type Crumb = { name: string; path: string };

export function breadcrumbList(crumbs: Crumb[]) {
  return {
    "@context": CONTEXT,
    "@type": "BreadcrumbList",
    itemListElement: crumbs.map((c, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: c.name,
      item: absoluteUrl(c.path),
    })),
  };
}

/** The ORM: an application (with its free offer) and its source code. Home page only. */
export function softwareGraph() {
  const version = cyphraVersion();
  return {
    "@context": CONTEXT,
    "@graph": [
      {
        "@type": "SoftwareApplication",
        "@id": SOFTWARE_ID,
        name: "Cyphra",
        alternateName: "Cyphra ORM",
        description:
          "A typed ORM for Neo4j and TypeScript: a .cyphra schema, a generated typed client, nested writes, transactions and migrations generated from schema changes.",
        url: SITE.url,
        applicationCategory: "DeveloperApplication",
        applicationSubCategory: "Object-relational mapper (ORM) for Neo4j",
        operatingSystem: "Linux, macOS, Windows (Node.js 20+)",
        softwareRequirements: "Node.js 20 or later, Neo4j 5.6 or later",
        ...(version ? { softwareVersion: version } : {}),
        downloadUrl: LINKS.npm,
        installUrl: absoluteUrl("/getting-started"),
        releaseNotes: LINKS.changelog,
        license: LICENSE_URL,
        isAccessibleForFree: true,
        offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
        author: { "@id": ORG_ID },
        publisher: { "@id": ORG_ID },
        image: absoluteUrl("/opengraph-image"),
      },
      {
        "@type": "SoftwareSourceCode",
        "@id": `${SITE.url}/#source`,
        name: "Cyphra",
        description: "Source code of the Cyphra ORM, CLI and docs (pnpm monorepo).",
        codeRepository: LINKS.github,
        programmingLanguage: { "@type": "ComputerLanguage", name: "TypeScript" },
        runtimePlatform: "Node.js",
        license: LICENSE_URL,
        author: { "@id": ORG_ID },
        targetProduct: { "@id": SOFTWARE_ID },
      },
    ],
  };
}

/** Cyphra Cloud with one Offer per plan that has a public price (Team is "Custom"). */
export function cloudProduct() {
  return {
    "@context": CONTEXT,
    "@type": "Product",
    "@id": CLOUD_ID,
    name: "Cyphra Cloud",
    description:
      "Managed Neo4j hosting: one dedicated Neo4j Community instance per database, with TLS endpoints, generated credentials and daily backups on paid plans.",
    url: absoluteUrl("/cloud"),
    image: absoluteUrl("/pricing/opengraph-image"),
    category: "Managed database hosting",
    brand: { "@type": "Brand", name: SITE.name },
    manufacturer: { "@id": ORG_ID },
    offers: PLANS.filter((p) => p.amount !== null).map((p) => ({
      "@type": "Offer",
      name: `${p.name} plan`,
      description: `${p.desc} Memory ${p.specs.Memory}, storage ${p.specs.Storage}, backups: ${p.specs.Backups}.`,
      url: absoluteUrl("/pricing"),
      price: String(p.amount),
      priceCurrency: "USD",
      availability: "https://schema.org/InStock",
      priceSpecification: {
        "@type": "UnitPriceSpecification",
        price: String(p.amount),
        priceCurrency: "USD",
        unitText: "per database per month",
        billingDuration: "P1M",
        valueAddedTaxIncluded: false,
      },
      seller: { "@id": ORG_ID },
    })),
  };
}

/** FAQPage for the questions rendered on the pricing page (same text, same order). */
export function pricingFaq() {
  return {
    "@context": CONTEXT,
    "@type": "FAQPage",
    mainEntity: FAQ.map(([q, a]) => ({
      "@type": "Question",
      name: q,
      acceptedAnswer: { "@type": "Answer", text: a },
    })),
  };
}

export function collectionPage({
  path,
  name,
  description,
  items,
}: {
  path: string;
  name: string;
  description: string;
  items: { name: string; path: string }[];
}) {
  return {
    "@type": "CollectionPage",
    "@id": absoluteUrl(path),
    url: absoluteUrl(path),
    name,
    description,
    inLanguage: SITE.language,
    isPartOf: { "@id": WEBSITE_ID },
    mainEntity: {
      "@type": "ItemList",
      itemListElement: items.map((it, i) => ({
        "@type": "ListItem",
        position: i + 1,
        name: it.name,
        url: absoluteUrl(it.path),
      })),
    },
  };
}

export { CONTEXT };
