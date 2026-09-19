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

## 6. Reactions and member invitation

The homepage keeps the notebook's paper, forest ink, leaf field, thin rules, and square edges. New reaction and preview chapters use the same primitives. The stage is a fixed-height, overflow-contained field, so moving imagery never changes document layout. Its twelve chosen Slack custom assets were screened in the site emoji inventory for generic imagery; ten are shipped locally on the homepage. GIFs appear only in the active rise layer. Static, real PNG assets make the six-image reduced-motion and no-script composition. No member photo or brand logo enters the site.

The rise layer moves only by `transform` and `opacity`, with a bounded random negative start delay. Visibility and document state pause the layer when it cannot be seen. The controls below it are a locally simulated OT1L conversation, with pressed state, visible garden cells, and a polite announcement. It performs no network write.

The invitation chapter uses the owner's exact spoken invitation and depicts a member-specific `/r/` link without making a shared link. The interest callout describes an optional private inquiry. The Worker renders its square, outlined link only when `PUBLIC_INTEREST_ENABLED=true`; otherwise it remains a non-interactive readiness label. The dedicated `/interest` page reuses the referral page's paper-and-leaf editorial grid, labelled controls, focus treatment, and mobile collapse. The closing chapter uses actual Day 1–Day 4 grass cells in three member rows. A shaded empty cell means a rest day, not a deleted history.

New homepage primitives: `reaction-stage`, `preview-controls`/`preview-conversation`, `invitation-note`, and `collective-garden`. They preserve the existing 1240px container and collapse into reading order below 760px. The preview paper tint `#fffdf5`, grass strokes `#39764d`/`#5f9b59`, and grass bed `#83ad6d` are illustration-only colors within the paper/leaf family. Controls use a 180ms state transition; reduced motion removes it.
