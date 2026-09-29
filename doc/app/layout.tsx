import { Footer, Layout, Navbar } from "nextra-theme-docs";
import { Head } from "nextra/components";
import { getPageMap } from "nextra/page-map";
import "nextra-theme-docs/style.css";
import type { ReactNode } from "react";
import { Analytics } from "@vercel/analytics/next";
import { AutoEvents } from "../components/auto-events";

export const metadata = {
  title: {
    default: "Cyphra",
    template: "%s | Cyphra",
  },
  description: "Cypher-first schema toolkit and migrations for Neo4j",
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
          docsRepositoryBase="https://github.com/cyphra/cyphra/tree/main/doc"
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
