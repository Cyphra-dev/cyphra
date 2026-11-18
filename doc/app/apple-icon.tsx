import { ImageResponse } from "next/og";
import { BRAND } from "../components/logo";

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
      <svg width="132" height="132" viewBox="4 4 24 24" fill="none">
        <defs>
          <linearGradient id="e" x1="16" y1="8" x2="16" y2="24" gradientUnits="userSpaceOnUse">
            <stop stopColor={BRAND.mint} />
            <stop offset="1" stopColor={BRAND.violet} />
          </linearGradient>
        </defs>
        <path
          d="M22.5 9C15 9 9.5 11 9.5 16S15 23 22.5 23"
          stroke="url(#e)"
          strokeWidth="2.4"
          strokeLinecap="round"
        />
        <circle cx="22.5" cy="9" r="3" fill={BRAND.ink} stroke={BRAND.mint} strokeWidth="2" />
        <circle cx="22.5" cy="23" r="3" fill={BRAND.ink} stroke={BRAND.violet} strokeWidth="2" />
        <circle cx="9.5" cy="16" r="3.6" fill={BRAND.mint} />
      </svg>
    </div>,
    size,
  );
}
