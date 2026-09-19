# OTL1 site design system

## 0. Research log

- Reference packet: studied the supplied editorial cadence: sticky navigation, numbered labels, thin rules, large chapters, a rail-and-reading-column rhythm, and its mobile collapse. It is a grammar reference only; no source copy, palette, names, typeface, copy, artwork, or layout asset is reused.
- Product source: `docs/PRODUCT_PRINCIPLES.md` anchors the story in a concrete daily practice, honest peer support, and a return path without guilt.
- Direction: **a field notebook becoming a garden.** Warm paper and forest ink make the site feel like a durable record; a single soft leaf-green field signals practice becoming visible. The memorable moment is the four square cells filling from a 10:00 intention into an 18:00 reflection.

## 1. Tokens

| Role | Token | Value |
| --- | --- | --- |
| Paper | `--paper` | `#f3f1e8` |
| Ink | `--ink` | `#16231e` |
| Night | `--night` | `#17231f` |
| Mist | `--mist` | `#d9ded5` |
| Leaf | `--leaf` | `#b9d885` |
| Rule | `--rule` | `rgba(22, 35, 30, .32)` |
| Sans | `--sans` | system Korean UI stack |
| Display | `--display` | Georgia and Korean serif fallbacks |

The spacing scale is 8, 16, 24, 32, 48, 72, and 112 pixels. Every surface is square and flat; rules describe boundaries instead of cards or shadows.

## 2. Type and layout

Display type uses a tight serif stack at 56–88px desktop and 38–54px mobile. Interface and reading copy use the system Korean UI stack. A maximum 1240px grid holds 12 columns; editorial chapters use a 3-column rail and 7-column reading block, then become one column under 760px.

## 3. Primitives

- `site-nav`: sticky semantic navigation with a native mobile disclosure button.
- `chapter-label`: topic, two-digit index, and one-pixel divider.
- `editorial`: rail, reading column, and an original inline SVG process illustration.
- `garden-cell`: a visual progress square with distinct fill and outline states; the site uses it as a decorative explanation of the product record, rather than an interactive control.

## 4. Motion and accessibility

Intersection observers reveal sections only after JavaScript has attached the motion class, so blocked JavaScript leaves all content visible. They do not run a continuous decorative animation. `prefers-reduced-motion: reduce` removes transforms, transitions, smooth scrolling, and animation while preserving final content states. Keyboard focus uses a high-contrast outline; diagrams have `role="img"` labels and decorative marks are hidden.

## 5. Responsive rules and accepted debt

The nav collapses at 760px, chapter typography scales through `clamp()`, diagrams remain inside their containers, and text wraps naturally without horizontal scrolling at 320px. The referral page keeps the same paper, ink, leaf, square controls, and editorial grid. Its form and receipt remain readable when the site's animation script does not run; Turnstile still needs its own script to validate a submission. The site Worker resolves opaque links through the core binding and sends validated applications through a signed request.
