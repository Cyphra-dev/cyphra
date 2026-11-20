import { ImageResponse } from "next/og";
import { BRAND, markPaths } from "../components/logo";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

// iOS adds its own rounded mask, so the tile is a full square here.
export default function AppleIcon() {
  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: BRAND.ink,
      }}
    >
      <svg width="116" height="116" viewBox="0 0 32 32" fill="none">
        {markPaths(BRAND.paper, BRAND.signal)}
      </svg>
    </div>,
    size,
  );
}
