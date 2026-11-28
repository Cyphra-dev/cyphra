// Cyphra Cloud plans. Rendered by the pricing page and reused for its structured data (JSON-LD)
// and llms-full.txt, so the numbers live in one place.
import { LINKS } from "../links";

export const APP_URL = "https://app.cyphra.dev";

// Keep in sync with config/billing.config.ts in the platform.
export const PLANS = [
  {
    name: "Free",
    price: "$0",
    amount: 0,
    period: "/mo",
    desc: "A small database for prototypes and side projects.",
    specs: { Memory: "1 GB", Storage: "2 GB", Backups: "None" },
    cta: "Start for free",
    href: `${APP_URL}/signup`,
  },
  {
    name: "Starter",
    price: "$29",
    amount: 29,
    period: "/mo",
    desc: "A dedicated instance for a first production app.",
    specs: { Memory: "2 GB", Storage: "10 GB", Backups: "Daily" },
    cta: "Choose Starter",
    href: `${APP_URL}/signup`,
  },
  {
    name: "Pro",
    price: "$99",
    amount: 99,
    period: "/mo",
    desc: "Production workloads with more headroom.",
    specs: { Memory: "8 GB", Storage: "50 GB", Backups: "Daily, 14-day retention" },
    cta: "Choose Pro",
    href: `${APP_URL}/signup`,
    highlight: true,
  },
  {
    name: "Team",
    price: "Custom",
    amount: null,
    period: "",
    desc: "Larger instances and shared workspaces.",
    specs: { Memory: "16 GB", Storage: "100 GB", Backups: "Talk to us about limits" },
    cta: "Contact us on GitHub",
    href: LINKS.issues,
  },
] as const;

export const INCLUDED = [
  "A dedicated Neo4j Community instance",
  "TLS endpoint (neo4j+s://)",
  "Generated credentials",
  "Online storage growth on upgrade",
  "Works with any Neo4j driver",
];

export const FAQ: [string, string][] = [
  [
    "Is it Neo4j Community or Enterprise?",
    "Neo4j Community Edition, single server, one dedicated instance per database. Clustering and other Enterprise features are not available.",
  ],
  [
    "Is the price per database?",
    "Yes. Each database has its own plan, and you can move it to a larger plan at any time. Storage grows online and never shrinks.",
  ],
  [
    "How do backups work?",
    "Paid plans take a daily dump stored outside the cluster. Neo4j Community has no online backup, so the database stops for the length of the dump.",
  ],
  [
    "Do I have to use the Cyphra OGM?",
    "No. Databases speak Bolt over TLS (neo4j+s://), so any Neo4j driver or tool works. The Cyphra OGM is free and open source either way.",
  ],
];
