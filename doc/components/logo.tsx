// The Cyphra mark: a three-node graph path that draws a "C". The two outer nodes are the ends
// of a relationship, the filled node is the one you query from. Mint → violet follows the
// brand palette (nodes → edges).

type MarkProps = { size?: number; className?: string };

export const BRAND = {
  ink: "#0b0b0e",
  mint: "#4be3a6",
  violet: "#a78bfa",
} as const;

export function LogoMark({ size = 24, className }: MarkProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <linearGradient
          id="cy-mark-edge"
          x1="16"
          y1="8"
          x2="16"
          y2="24"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor={BRAND.mint} />
          <stop offset="1" stopColor={BRAND.violet} />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="8" fill={BRAND.ink} />
      <rect x="0.5" y="0.5" width="31" height="31" rx="7.5" stroke="#ffffff" strokeOpacity="0.12" />
      <path
        d="M22.5 9C15 9 9.5 11 9.5 16S15 23 22.5 23"
        stroke="url(#cy-mark-edge)"
        strokeWidth="2.4"
        strokeLinecap="round"
      />
      <circle cx="22.5" cy="9" r="3" fill={BRAND.ink} stroke={BRAND.mint} strokeWidth="2" />
      <circle cx="22.5" cy="23" r="3" fill={BRAND.ink} stroke={BRAND.violet} strokeWidth="2" />
      <circle cx="9.5" cy="16" r="3.6" fill={BRAND.mint} />
    </svg>
  );
}

export function Logo() {
  return (
    <span className="cy-logo">
      <LogoMark size={26} />
      <span className="cy-logo-word">cyphra</span>
    </span>
  );
}
