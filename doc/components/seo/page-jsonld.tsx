// Page-level structured data, rendered from the MDX pages that need it.
import { JsonLd } from "./json-ld";
import { cloudProduct, pricingFaq, softwareGraph } from "./structured-data";

/** Home: the ORM as a SoftwareApplication (free offer) and its SoftwareSourceCode. */
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
