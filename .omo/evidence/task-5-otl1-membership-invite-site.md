# Todo 5: isolated ONE THING site shell

## Scope

Owned source is `site/**` plus `qa/site-static.mjs`. The site is a separate Workers Static Assets Worker with an `ASSETS` binding, a `CORE` service-binding seam, and the documented public Turnstile test site key. It has no route or production deployment.

## Failing-first characterization

| Scenario | Invocation | Binary observation | Artifact |
| --- | --- | --- | --- |
| Site contract before implementation | `bun qa/site-static.mjs` | Exit 1: missing `site/wrangler.jsonc` | `task-5-static-red.txt` |
| Existing core baseline | `bun run check` | Exit 0 before site edits | terminal output captured in task transcript |

## Implementation evidence

| Criterion | Invocation | Binary observation | Artifact |
| --- | --- | --- | --- |
| Static semantic, isolation, and reduced-motion contract | `bun qa/site-static.mjs` | Exit 0, `PASS site static` | `task-5-site-static-final.txt` |
| Static Assets Worker config | `wrangler deploy --dry-run -c site/wrangler.jsonc` | Exit 0; binds only `CORE`, `ASSETS`, and `TURNSTILE_SITE_KEY` | `task-5-site-dry-run-final.txt` |
| Core regression remains clean | `bun run check` | Exit 0: lint, typecheck, 54 suites, dry-run build | `task-5-core-check-final.txt` |
| Public source scan | `rg` secret/reference scan plus `git diff --check` | No secret, production identifier, or copied-reference match; whitespace clean | `task-5-scope-secret-scan-final.txt` |

## Browser acceptance

The local Worker was started with `wrangler dev -c site/wrangler.jsonc --port 8788 --ip 127.0.0.1` and stopped after capture. Chrome drove the actual Worker at 1440×900, 375×812, and 320×812.

| Scenario | Binary observation | Artifact |
| --- | --- | --- |
| Desktop/mobile/small layout | `scrollWidth === clientWidth` at 1440, 375, and 320 | `task-5-browser-observations.json` |
| Section coverage | All five visible sections captured at 1440, 375, and 320: home, rhythm, garden, support, return | `task-5-site-{1440,375,320}-{home,rhythm,garden,support,return}.png` |
| Keyboard path | First two focus targets are the wordmark and native menu button, each with 3px outline; menu opens to `display:grid` | `task-5-browser-observations.json` |
| 320px long Korean | Visible long support copy, no horizontal overflow | `task-5-site-320-long-korean.png`, `task-5-browser-observations.json` |
| JavaScript blocked | Product heading present and mobile links remain `display:grid` | `task-5-site-375-no-js.png`, `task-5-browser-observations.json` |
| Reduced motion | Media query matches, page does not attach motion class, transition duration is 0.01ms | `task-5-site-375-reduced-motion.png`, `task-5-browser-observations.json` |
| Failure paths and headers | Unknown document and missing asset both return 404; CSP, HSTS, nosniff, and referrer policy headers present | `task-5-browser-observations.json`, `task-5-site-headers.txt` |

## Visual-review loop

Independent visual review found and the implementation fixed: no-JS mobile navigation, flattened peer/support semantics, decorative infinite motion, incomplete below-fold evidence, and CJK word/phrase breaks. Final fresh integrity and CJK reviewers both returned `PASS` with no blocking findings against the current capture set.

## Cleanup and limits

- Local Wrangler development server stopped cleanly after capture.
- No production deploy, custom-domain creation, Slack/Neon/R2 access, or form submission occurred.
- The service binding and public Turnstile key are configuration seams only. A state-changing intake flow remains Todo 10 work.
