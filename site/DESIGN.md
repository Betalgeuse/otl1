# OTL1 site design system

## 0. Research log

- Reference packet: studied the supplied editorial cadence: sticky navigation, numbered labels, thin rules, large chapters, a rail-and-reading-column rhythm, and its mobile collapse. It is a grammar reference only; no source copy, palette, names, typeface, copy, artwork, or layout asset is reused.
- Product source: `docs/PRODUCT_PRINCIPLES.md` anchors the story in a concrete daily practice, honest peer support, and a return path without guilt.
- Direction: **a field notebook becoming a garden.** Warm paper and forest ink make the site feel like a durable record; a single soft leaf-green field signals practice becoming visible. The memorable moment is the four square cells filling from a 10:00 intention into an 18:00 reflection.

## 0.1 Daily-thread redesign plan

The prior preview swapped one generic bot card among three states. It did not show the actual shape of the daily practice and incorrectly described the morning goal and evening review as one Slack thread. Preserve the paper, ink, leaf field, thin rules, and square controls; replace only that preview with two short, clearly separated fictional `#daily-scrum` conversations: a 10:00 goal root and an 18:00 review root.

The preview uses one native replay button. A user-triggered replay reveals already-reserved rows in their reading order with only opacity and an upward transform; it never sends a Slack request or fabricates an ongoing chat. JavaScript-disabled and reduced-motion presentations show the complete example and its final single Day 1 completion cell immediately. The referral page borrows a compact two-thread explanation before its existing application form so an invitee can understand the routine without duplicating the full preview.

## 1. Tokens

| Role | Token | Value |
| --- | --- | --- |
| Paper | `--paper` | `#f3f1e8` |
| Ink | `--ink` | `#16231e` |
| Night | `--night` | `#17231f` |
| Mist | `--mist` | `#d9ded5` |
| Leaf | `--leaf` | `#b9d885` |
| Rule | `--rule` | `rgba(22, 35, 30, .32)` |
| Return field | `--return-field` | `#d8ddd4` |
| Preview paper | `--paper-preview` | `#fffdf5` |
| Focus ink | `--focus-ink` | `#387149` |
| Muted UI ink | `--ink-muted` / `--ink-subtle` | `#43534b` / `#526158` |
| Inverse rule | `--rule-inverse` / `--rule-inverse-strong` | paper at 40% / 50% |
| Sans | `--sans` | system Korean UI stack |
| Display | `--display` | Georgia and Korean serif fallbacks |

The spacing scale is `--space-8`, `--space-16`, `--space-24`, `--space-32`, `--space-48`, `--space-72`, and `--space-112`. Named component increments keep the smaller optical gaps and editorial geometry inspectable without introducing literal values into rules. Every surface is square and flat; rules describe boundaries instead of cards or shadows.

## 2. Type and layout

Display type uses `--display-hero` and `--display-section`, a tight serif stack at 56–88px desktop and 38–54px mobile. Interface and reading copy use `--type-11` through `--type-21` in the system Korean UI stack; `--type-caption`, `--type-label`, `--type-body`, and `--type-reading` alias the recurring role sizes. A maximum 1240px grid holds 12 columns; editorial chapters use a 3-column rail and 7-column reading block, then become one column under 760px.

## 3. Primitives

- `site-nav`: sticky semantic navigation with a native mobile disclosure button.
- `chapter-label`: topic, two-digit index, and one-pixel divider.
- `editorial`: rail, reading column, and an original inline SVG process illustration.
- `garden-cell`: a visual progress square with distinct fill and outline states; the site uses it as a decorative explanation of the product record, rather than an interactive control.
- `collective-board`: a single, responsive production-rendered PNG for the fictional four-day example. `site/qa/generate-example-board.mts` calls `renderBoard` with `DEFAULT_PALETTE`, so the visible DAY labels, completion checks, today outline, and future cell are the same board language sent to Slack.
- `daily-thread`: a square, source-labeled fictional `#daily-scrum` root conversation. A morning goal and evening review are separate thread primitives, never a single simulated Slack thread.
- `daily-row`: a reserved-height member, bot, or peer row that enters only through opacity and an upward transform after a user asks to replay the example.

## 4. Motion and accessibility

Intersection observers reveal sections only after JavaScript has attached the motion class, so blocked JavaScript leaves all content visible. They do not run a continuous decorative animation. `prefers-reduced-motion: reduce` removes transforms, transitions, smooth scrolling, and animation while preserving final content states. Keyboard focus uses a high-contrast outline; diagrams have `role="img"` labels and decorative marks are hidden.

## 5. Responsive rules and accepted debt

The nav collapses at 760px, chapter typography scales through `clamp()`, diagrams remain inside their containers, and text wraps naturally without horizontal scrolling at 320px. The referral page reuses the homepage rhythm, reaction stage, two-thread replay, and collective board; only its hero copy and final application form change. Its form and receipt remain readable when the site's animation script does not run; Turnstile still needs its own script to validate a submission. The site Worker resolves opaque links through the core binding and sends validated applications through a signed request.

## 6. Reactions and member invitation

The homepage keeps the notebook's paper, forest ink, leaf field, thin rules, and square edges. New reaction and preview chapters use the same primitives. The reaction imagery is an absolute, transparent layer behind the leaf chapter copy. It contributes no layout height, border, fill, or pointer target; each sprite fades to zero before reaching the section edge. A transparent mask quiets motion under the copy, preserving contrast without a backing panel. Eight screened Slack custom assets with verified transparent alpha are shipped locally. The opaque blue completion tile and white-backed cat are excluded. GIFs appear only in the active rise layer. Static, real PNG assets make the six-image reduced-motion and no-script composition. No member photo or brand logo enters the site.

The rise layer moves only by `transform` and `opacity`, with a bounded random negative start delay. Visibility and document state pause the layer when it cannot be seen. The preview below it is a locally simulated pair of `#daily-scrum` root conversations. One native replay button reveals its fixed rows in reading order, retains focus, and only updates a polite status region; it performs no network write. `Escape` cancels the remaining timer without hiding rows already shown. Reduced motion and no-JavaScript show the whole fictional example immediately.

The invitation chapter uses the owner's exact spoken invitation and depicts a member-specific `/r/` link without making a shared link. The interest callout describes an optional private inquiry. The Worker renders its square, outlined link only when `PUBLIC_INTEREST_ENABLED=true`; otherwise it remains a non-interactive readiness label. The dedicated `/interest` page reuses the referral page's paper-and-leaf editorial grid, labelled controls, focus treatment, and mobile collapse. The closing chapter uses the one fictional Day 1–Day 4 production board PNG on both homepage and referral page. Its first three cells are complete and checked; Day 4 remains the renderer's future empty cell.

New homepage primitives: a transparent `reaction-stage` layer, `daily-thread`/`daily-row`, `daily-garden`, `invitation-note`, and `collective-board`. They preserve the existing 1240px container and collapse into reading order below 760px. The preview paper tint `#fffdf5` keeps the board image readable without replacing it with CSS illustration. Message rows use a 180ms opacity/transform transition; reduced motion removes it.
