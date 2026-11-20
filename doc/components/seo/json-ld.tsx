// Renders structured data as a JSON-LD <script>. Escapes everything that could close the script
// tag or break the JSON when inlined in HTML (`<`, `>`, `&`, U+2028, U+2029).

const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);

export function serializeJsonLd(data: unknown): string {
  return JSON.stringify(data)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .split(LS)
    .join("\\u2028")
    .split(PS)
    .join("\\u2029");
}

export function JsonLd({ data }: { data: unknown }) {
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: serializeJsonLd(data) }}
    />
  );
}
