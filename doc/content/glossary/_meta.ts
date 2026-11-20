import type { MetaRecord } from "nextra";

// The index page (app/glossary/page.tsx) is full width; every entry gets an on-page TOC.
const meta: MetaRecord = {
  index: { theme: { layout: "full", toc: false } },
  "*": { theme: { layout: "default", toc: true } },
};

export default meta;
