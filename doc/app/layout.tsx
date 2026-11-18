import { Footer, Layout, Navbar } from "nextra-theme-docs";
import { Head } from "nextra/components";
import { getPageMap } from "nextra/page-map";
import "nextra-theme-docs/style.css";
import "./globals.css";
import type { Metadata, Viewport } from "next";
import { Instrument_Sans, JetBrains_Mono } from "next/font/google";
import type { ReactNode } from "react";
import { Analytics } from "@vercel/analytics/next";
import { AutoEvents } from "../components/auto-events";
import { LINKS, SITE_URL } from "../components/links";
import { Logo } from "../components/logo";
import { SiteFooter } from "../components/site-footer";

const sans = Instrument_Sans({
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap",
});

const mono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  display: "swap",
});

const description =
  "Cyphra is the typed ORM for Neo4j: describe your graph in a .cyphra schema, get a fully typed TypeScript client, and generate migrations from schema changes. Open source, MIT.";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: "Cyphra: the typed ORM for Neo4j and TypeScript",
    template: "%s | Cyphra",
  },
  description,
  applicationName: "Cyphra",
  keywords: ["Neo4j", "ORM", "TypeScript", "Cypher", "graph database", "migrations", "Prisma"],
  // "./" resolves against each route, so every page gets its own canonical URL.
  alternates: { canonical: "./" },
  openGraph: { type: "website", siteName: "Cyphra", url: "./", locale: "en_US" },
  twitter: { card: "summary_large_image" },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#09090b" },
  ],
};

function NpmIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true">
      <path d="M1.763 0C.786 0 0 .786 0 1.763v20.474C0 23.214.786 24 1.763 24h20.474c.977 0 1.763-.786 1.763-1.763V1.763C24 .786 23.214 0 22.237 0zM5.13 5.323l13.837.019-.009 13.836h-3.464l.01-10.382h-3.456L12.04 19.17H5.113z" />
    </svg>
  );
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  const pageMap = await getPageMap();
  return (
    <html
      lang="en"
      dir="ltr"
      suppressHydrationWarning
      className={`${sans.variable} ${mono.variable}`}
    >
      <Head
        color={{
          hue: { light: 159, dark: 156 },
          saturation: { light: 94, dark: 73 },
          lightness: { light: 25, dark: 59 },
        }}
        backgroundColor={{ light: "#ffffff", dark: "#09090b" }}
      />
      <body>
        <Layout
          navbar={
            <Navbar logo={<Logo />} projectLink={LINKS.github}>
              <a href={LINKS.npm} className="cy-nav-icon" aria-label="cyphra on npm">
                <NpmIcon />
              </a>
            </Navbar>
          }
          pageMap={pageMap}
          docsRepositoryBase={LINKS.docsSource}
          editLink="Edit this page on GitHub"
          feedback={{ content: "Question? Open an issue", labels: "docs" }}
          sidebar={{ defaultMenuCollapseLevel: 1, toggleButton: true }}
          toc={{ backToTop: "Back to top" }}
          footer={
            <Footer className="cy-footer-wrap">
              <SiteFooter />
            </Footer>
          }
        >
          {children}
        </Layout>
        <Analytics />
        <AutoEvents />
      </body>
    </html>
  );
}
