import type { ReactNode } from "react";
import { Providers } from "@/trpc/client";

export const metadata = { title: "Cyphra + tRPC" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, sans-serif", maxWidth: 720, margin: "2rem auto" }}>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
