// security.txt (RFC 9116): where to report vulnerabilities. Reports go through GitHub's private
// vulnerability reporting, as described in SECURITY.md. `Expires` is required by the RFC and is set
// one year after the build; every deploy refreshes it.
import { absoluteUrl } from "../../../lib/site";

export const dynamic = "force-static";

export function GET() {
  const expires = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
  expires.setUTCHours(0, 0, 0, 0);
  const lines = [
    "Contact: https://github.com/Cyphra-dev/cyphra/security/advisories/new",
    `Expires: ${expires.toISOString()}`,
    `Canonical: ${absoluteUrl("/.well-known/security.txt")}`,
    "Policy: https://github.com/Cyphra-dev/cyphra/blob/main/SECURITY.md",
    "Preferred-Languages: en",
  ];
  return new Response(`${lines.join("\n")}\n`, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
