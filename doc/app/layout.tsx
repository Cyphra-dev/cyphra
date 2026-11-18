import { Footer, Layout, Navbar } from "nextra-theme-docs";
import { Head } from "nextra/components";
import { getPageMap } from "nextra/page-map";
import "nextra-theme-docs/style.css";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Analytics } from "@vercel/analytics/next";
import { AutoEvents } from "../components/auto-events";

export const metadata: Metadata = {
  metadataBase: new URL("https://www.cyphra.dev"),
  title: {
    default: "Cyphra: TypeScript schema, Cypher queries and migrations for Neo4j",
    template: "%s | Cyphra",
  },
  description:
    "Cyphra is an open-source TypeScript toolkit for Neo4j: a Prisma-like schema, parameterized Cypher queries, versioned migrations and a CLI.",
  // "./" resolves against each route, so every page gets its own canonical URL.
  alternates: { canonical: "./" },
  openGraph: { type: "website", siteName: "Cyphra", url: "./" },
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
          docsRepositoryBase="https://github.com/Cyphra-dev/cyphra/tree/main/doc"
          footer={<Footer>Cyphra — MIT</Footer>}
        >
          {children}
        </Layout>
        <Analytics />
        <AutoEvents />
      </body>
    </html>
  );
}
