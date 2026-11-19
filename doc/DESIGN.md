# Cyphra design kit

The visual identity of cyphra.dev, written so the platform (`app.cyphra.dev`) and any future surface
can adopt it as is. Source of truth for tokens: [`app/globals.css`](app/globals.css). Brand assets:
[`public/brand/`](public/brand).

## 1. Idea

**Ink, paper and one signal.** Cyphra is a typed ORM for a graph database. Its identity borrows from
the two things its users read all day: technical paper (precise type on a warm off-white page) and
Cypher, Neo4j's query language, where a relationship is drawn as an arrow:
`(:User)-[:AUTHORED]->(:Post)`.

- **Monochrome first.** Near-black ink on warm paper in light mode, bone on deep black in dark mode.
  Both themes are designed, neither is derived from the other.
- **One accent, used only where things connect.** Signal vermilion marks arrows, links, the active
  item, the focus ring and the primary CTA's arrow. If something is not a connection or an
  action, it is not vermilion.
- **Real product, not decoration.** Code, schemas, terminals and graph diagrams carry the pages.
  No glows, blobs, gradients or stock 3D.
- **Schematic graph lines.** When we draw a graph, it is a diagram: hairline edges, pill-shaped
  nodes labeled like Cypher (`(alice:User)`), arrowheads in signal.

Why vermilion: it is unclaimed among neighbours (Neo4j blue, Supabase green, Prisma indigo, Drizzle
lime, Clerk purple), reads as "signal" rather than "brand gradient", and holds AA contrast as text in
both themes in its text variants.

## 2. Logo

The mark is Cypher's relationship syntax reduced to two strokes: the `(` of a node, which doubles as
the **C**, and an outgoing relationship arrow `→`. Only the arrowhead takes the signal color.

| Asset                               | Use                                                    |
| ----------------------------------- | ------------------------------------------------------ |
| `public/brand/cyphra-logo.svg`      | Lockup, ink on light backgrounds                       |
| `public/brand/cyphra-logo-dark.svg` | Lockup, bone on dark backgrounds                       |
| `public/brand/cyphra-mark.svg`      | Mark alone, light backgrounds                          |
| `public/brand/cyphra-mark-dark.svg` | Mark alone, dark backgrounds                           |
| `app/icon.svg`                      | Favicon: mark on an ink tile (works on any tab color)  |
| `app/apple-icon.tsx`                | 180×180 touch icon, full-bleed ink square              |
| `components/logo.tsx`               | `<Logo />`, `<LogoMark />`, `markPaths()` for React/OG |

Geometry (32×32 grid, stroke 3.4, round caps and joins):

```
node  M10 5C4.5 9 4.5 23 10 27
edge  M12.5 16H25
head  M20 10.5 25.5 16 20 21.5      ← signal
```

The wordmark is "cyphra", lowercase, Schibsted Grotesk SemiBold at -5% tracking, **outlined** in
`WORDMARK.d` so it renders identically everywhere. In the lockup, the mark is 108 units tall (on a
100-unit type size), vertically centered on the x-height, with a 20-unit gap.

Rules:

- Minimum sizes: mark 16 px, lockup 18 px tall.
- Clear space: the height of the `(` on every side.
- The arrowhead is always signal (`#FF4F1F`), or the same color as the rest of the mark in
  one-color contexts (embossing, monochrome print). Never recolor the `(` or the edge.
- Do not add a tile, gradient, outline or shadow to the mark, except for the favicon tile.
- Do not set "cyphra" in another font, capitalize it, or rebuild the lockup with live text.

## 3. Color

All tokens are plain CSS variables on `:root` (light) and `html.dark` (dark). Copy the block from
`app/globals.css` into another app; nothing depends on Nextra.

### Signal

| Token              | Light     | Dark      | Role                                                          |
| ------------------ | --------- | --------- | ------------------------------------------------------------- |
| `--cy-signal`      | `#FF4F1F` | `#FF5A2B` | Graphics only: arrowheads, dots, rules, focus ring (≥ 3:1)    |
| `--cy-signal-text` | `#C2370C` | `#FF7A50` | Links and accent text (5.0:1 on paper, 7.9:1 on black)        |
| `--cy-signal-soft` | 10% tint  | 12% tint  | Active sidebar item, selection in menus, typed-property chips |

### Neutrals

| Token                | Light (paper) | Dark (black) | Role                                         |
| -------------------- | ------------- | ------------ | -------------------------------------------- |
| `--cy-bg`            | `#F6F5F1`     | `#050505`    | Page background                              |
| `--cy-bg-subtle`     | `#EFEDE7`     | `#0A0A0A`    | Bands, alternating areas                     |
| `--cy-surface`       | `#FDFCFA`     | `#0E0E0E`    | Cards, popovers, plans                       |
| `--cy-surface-2`     | `#F1EFEA`     | `#151515`    | Window bars, tabs, inline code               |
| `--cy-border`        | `#E2DFD7`     | `#222221`    | Hairlines, card borders                      |
| `--cy-border-strong` | `#CFCBC1`     | `#313130`    | Inputs, secondary buttons, popovers          |
| `--cy-fg`            | `#0C0C0B`     | `#EDECE8`    | Ink / bone: headings and body                |
| `--cy-fg-muted`      | `#55534D`     | `#A3A19A`    | Secondary text (7.0:1 / 7.9:1)               |
| `--cy-fg-subtle`     | `#6E6B64`     | `#8C8A84`    | Captions, meta, line numbers (4.9:1 / 5.6:1) |
| `--cy-code-bg`       | `#FDFCFA`     | `#0B0B0B`    | Code blocks                                  |
| `--cy-danger`        | `#C4221B`     | `#FF6B5E`    | Errors, type-error squiggles                 |

Buttons: `--cy-btn-bg` / `--cy-btn-fg` / `--cy-btn-hover` invert ink and paper per theme. The
primary button is **ink, not vermilion**; its arrow is the signal.

### Code

Ink first: identifiers stay in the text color, so code reads calm. Defined in `lib/shiki.mjs`,
all ≥ 4.5:1 on `--cy-code-bg`.

| Scope                | Light     | Dark      |
| -------------------- | --------- | --------- |
| Keywords, decorators | `#C2370C` | `#FF8A63` |
| Strings              | `#3B6B2A` | `#A9C99A` |
| Types                | `#8A5300` | `#E3C18A` |
| Numbers, constants   | `#1F5F99` | `#93BDF0` |
| Comments             | `#6E6B64` | `#86847D` |
| Punctuation          | `#6A675F` | `#9A9891` |

## 4. Type

| Role    | Family            | Weights | Notes                                                    |
| ------- | ----------------- | ------- | -------------------------------------------------------- |
| Display | Schibsted Grotesk | 600     | Headlines, prices, wordmark. Tight tracking.             |
| Text    | Inter             | 400–600 | Body, UI.                                                |
| Code    | Geist Mono        | 400–500 | Code, labels, eyebrows. **Ligatures off** (Cypher `->`). |

All three are SIL Open Font License (free to embed and redistribute). The site loads them with
`next/font/google`; `assets/fonts/` holds static TTFs for OG images, with their licenses.

CSS variables: `--cy-font-display`, `--x-font-sans`, `--x-font-mono`.

Scale (fluid where marked):

| Step    | Size                             | Line height | Tracking |
| ------- | -------------------------------- | ----------- | -------- |
| Hero    | `clamp(2.75rem, 5.6vw, 4.75rem)` | 0.98        | -0.05em  |
| H2      | `clamp(2rem, 4.2vw, 3.25rem)`    | 1.02        | -0.045em |
| Docs H1 | `clamp(2rem, 4vw, 2.5rem)`       | 1.1         | -0.04em  |
| H3      | 1.0625rem                        | 1.3         | -0.015em |
| Lede    | 1.0625–1.1875rem                 | 1.6         | 0        |
| Body    | 1rem (docs) / 0.9375rem (UI)     | 1.6–1.75    | 0        |
| Eyebrow | 0.75rem mono, uppercase          | 1           | 0.06em   |
| Code    | 0.8125rem                        | 1.7         | 0        |

Eyebrows start with `(→` in signal: the mark as a bullet.

## 5. Space, radius, depth

- **Spacing** on a 4 px base: 4, 8, 12, 16, 24, 32, 48, 64. Sections are separated by
  `clamp(80px, 11vw, 136px)`. Container 1200 px, gutters 24 px (16 px under 640 px).
- **Radius:** `--cy-radius-sm` 6 px (inline code, small chips), `--cy-radius` 10 px (code blocks,
  inputs, buttons use 9 px), `--cy-radius-lg` 14 px (cards, windows). Pills: 999 px.
- **Shadows:** almost none. `--cy-shadow` for windows, `--cy-shadow-lg` for the hero editor,
  popovers and the highlighted plan. Borders do the work; shadows only lift what floats.
- **Easing:** `--cy-ease: cubic-bezier(0.2, 0.7, 0.1, 1)`; 150 ms for color, 200 ms for transforms.

## 6. Components

- **Buttons.** Primary: ink fill, paper text, signal arrow that nudges 3 px on hover. Secondary:
  surface fill, strong border. Ghost: text only. Height 44 px (touch target).
- **Copy command.** `$ npm i cyphra` in mono with a copy button; `$` in signal text; announces
  "Copied to clipboard" to screen readers.
- **Window.** A code card with a 40 px bar showing the filename in mono, and an optional pill badge.
  No traffic-light dots.
- **Editor.** Window + tabs (active tab has a 2 px signal top rule), line numbers, a status bar.
- **Graph diagram.** Pill nodes `(name:Label)` in mono, hairline edges, signal arrowheads, relationship
  types in small caps, typed edge properties as a signal-tinted chip.
- **Cards and bento tiles.** Surface fill, 1 px border, 14 px radius, border darkens on hover.
- **Pricing plan.** Mono plan name, display price, a spec table (Memory / Storage / Backups) aligned
  across plans. The recommended plan gets an ink outline and a 2 px signal rule on top.
- **Callouts (docs).** Surface card, hairline border, a 3 px left rule: signal (info), amber
  (warning), danger (error).
- **Focus.** Every focusable element: 2 px signal outline, 2 px offset.

## 7. Motion

Purposeful and quiet; CSS and SVG only, no JS libraries.

- Hero editor: typing, an autocomplete popover, then the inferred type on hover. 11 s loop.
- Graph edges draw in as they scroll into view; a short signal dash travels each edge.
- Sections fade up 18 px on entry (scroll-driven `animation-timeline: view()`, progressive).
- The Cypher pattern band scrolls slowly.
- Only `transform`, `opacity` and stroke properties animate: no layout shift.
- `prefers-reduced-motion: reduce` turns all of it off and shows the final state.

## 8. Open Graph

One template (`components/og.tsx`), 1200×630, always on deep black:

1. Top left: the lockup (44 px) and a mono section label (`/ docs`, `/ pricing`).
2. A huge Schibsted title (116 / 92 / 76 px by length), then at most two lines of description.
3. Along the bottom: one schematic edge, a hollow node to a signal arrowhead, captioned with the
   page as a Cypher pattern, e.g. `(:Docs)-[:COVERS]->(:Migrations)`, and `cyphra.dev`.

No screenshots, gradients or illustrations in OG images.

## 9. Voice

Short and exact. Say what the thing does, with the real noun: "Migrations from schema diffs", not
"Supercharge your workflow". Prefer code to adjectives. No exclamation marks, no emoji. Technical
claims must match the code and docs (versions, commands, limits).

## 10. Porting checklist (app.cyphra.dev)

1. Copy the `:root` and `html.dark` blocks from `app/globals.css` (drop the `--x-*` Nextra lines).
2. Load Schibsted Grotesk, Inter and Geist Mono with `next/font/google`, exposing
   `--font-display`, `--font-sans`, `--font-mono`.
3. Copy `components/logo.tsx` and `public/brand/*`; reuse `app/icon.svg` and `app/apple-icon.tsx`.
4. Copy `lib/shiki.mjs` for code highlighting.
5. Set `theme-color` to `#F6F5F1` (light) and `#050505` (dark).
