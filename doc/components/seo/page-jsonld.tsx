// Page-level structured data, rendered from the MDX pages that need it.
import { JsonLd } from "./json-ld";
import {
  CONTEXT,
  cloudProduct,
  collectionPage,
  faqPage,
  howTo,
  pricingFaq,
  softwareGraph,
} from "./structured-data";

/** Home: the OGM as a SoftwareApplication (free offer) and its SoftwareSourceCode. */
export function HomeJsonLd() {
  return <JsonLd data={softwareGraph()} />;
}

/** Pricing: Cyphra Cloud with one Offer per priced plan, and the FAQ shown on the page. */
export function PricingJsonLd() {
  return (
    <>
      <JsonLd data={cloudProduct()} />
      <JsonLd data={pricingFaq()} />
    </>
  );
}

/** Cloud docs: the same Cyphra Cloud product and offers. */
export function CloudJsonLd() {
  return <JsonLd data={cloudProduct()} />;
}

/** A page's FAQ, written out in its MDX too: the questions and answers must match what is shown. */
export function FaqJsonLd({ items }: { items: readonly (readonly [string, string])[] }) {
  return <JsonLd data={faqPage(items)} />;
}

/** An index page that lists other pages (for example /compare). */
export function CollectionJsonLd(props: Parameters<typeof collectionPage>[0]) {
  return <JsonLd data={{ "@context": CONTEXT, ...collectionPage(props) }} />;
}

/** Guides: a HowTo whose steps are the visible `<Steps>` headings of the page. */
export function HowToJsonLd(props: Parameters<typeof howTo>[0]) {
  return <JsonLd data={howTo(props)} />;
}
