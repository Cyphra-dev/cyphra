import { Footer, Layout, Navbar } from "nextra-theme-docs";
import { Head } from "nextra/components";
import { getPageMap } from "nextra/page-map";
import "nextra-theme-docs/style.css";
import type { Metadata } from "next";
import type { ReactNode } from "react";

const description =
  "TypeScript toolkit for Neo4j: .cyphra schema, parameter-safe Cypher, Cyphra Client, migrations, and CLI.";

export const metadata: Metadata = {
  metadataBase: new URL("https://www.cyphra.dev"),
  title: {
    default: "Cyphra",
    template: "%s | Cyphra",
  },
  description,
  openGraph: {
    title: "Cyphra",
    description,
    url: "https://www.cyphra.dev",
    siteName: "Cyphra",
    locale: "en",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Cyphra",
    description,
  },
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const pageMap = await getPageMap();
  return (
    <html lang="en" dir="ltr" suppressHydrationWarning>
      <Head />
      <body>
        <Layout
          navbar={<Navbar logo={<b>Cyphra</b>} />}
          pageMap={pageMap}
          docsRepositoryBase="https://github.com/cyphra-dev/cyphra/tree/main/doc"
          footer={
            <Footer>
              <span>Cyphra — MIT · </span>
              <a href="https://www.cyphra.dev">cyphra.dev</a>
              <span> · </span>
              <a href="https://github.com/cyphra-dev/cyphra">GitHub</a>
            </Footer>
          }
        >
          {children}
        </Layout>
      </body>
    </html>
  );
}
