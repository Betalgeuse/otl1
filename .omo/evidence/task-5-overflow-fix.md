# Todo 5 320px overflow repair

## Failing proof at `b0b55028d15f22429d6e76c669a67dc62bd1190d`

- Local Chrome at 320 × 812 measured `body.scrollWidth=370`, hero `right=370.234375`, and thread `scrollWidth=300` with `clientWidth=288`.
- [`task-5-overflow-red.json`](./task-5-overflow-red.json) and [`task-5-overflow-red-320.png`](./task-5-overflow-red-320.png) capture that state.
- The updated `bun qa/site-static.mjs` failed before the CSS repair because the stylesheet contained `overflow-x:clip`; see [`task-5-overflow-static-red.txt`](./task-5-overflow-static-red.txt).

## Cause and fix

The mobile hero was 115% wide with a negative right offset. The peer message began at 20% inside a 288px scene despite its 84% width. Root/body clipping hid the first failure but did not eliminate layout overflow.

The repair removes root/body horizontal clipping, fits the hero to its mobile container, and moves the peer card to 16%. A live browser toggle changed `body=370/heroRight=370.234375/thread=300` to `320/304/288`, then restored the failing values when reverted.

## Green proof

- Fresh Chrome captured all five chapters at 1440 × 900, 375 × 812, and 320 × 812, plus long Korean, no-JS, and reduced-motion scenarios.
- [`task-5-overflow-green.json`](./task-5-overflow-green.json) records at 320: document/body `320/320`, hero `right=304`, thread `288/288`, peer `right=303.984375`, and `visibleOverflow=[]`.
- `bun qa/site-static.mjs` passed with the browser-observation contract; see [`task-5-overflow-static-green.txt`](./task-5-overflow-static-green.txt).
- The focused Worker dry run, root check, and secret/scope scan passed. One fresh integrity reviewer and one fresh CJK reviewer both returned `PASS` against the settled final captures.

## Cleanup

The local Worker was stopped. The local debug journal will be removed before commit; no production deployment or external data effect occurred.
