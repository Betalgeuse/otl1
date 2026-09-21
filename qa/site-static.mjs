import { readFile, stat } from "node:fs/promises";
import assert from "node:assert/strict";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const read = async (path) => readFile(resolve(root, path), "utf8");
const mustExist = async (path) => stat(resolve(root, path));

const config = JSON.parse(await read("site/wrangler.jsonc"));
const worker = await read("site/src/index.ts");
const page = await read("site/dist/index.html");
const referral = await read("site/dist/referral.html");
const css = await read("site/dist/styles.css");
const script = await read("site/dist/app.js");
const beforeReviewBoard = await readFile(resolve(root, "site/dist/assets/fictional-four-day-board-before-review.png"));
const completeBoard = await readFile(resolve(root, "site/dist/assets/fictional-four-day-board-complete.png"));
const documentText = page.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
const productionHostname = "otl1.hyuk.me";
const turnstileTestSiteKey = "1x00000000000000000000AA";
const turnstileProductionSiteKey = "0x4AAAAAAE83tTpMHyLr4nIv";

await Promise.all([
  mustExist("site/dist/404.html"),
  mustExist("site/dist/boot.js"),
  mustExist("site/DESIGN.md"),
  mustExist("site/dist/assets/fictional-four-day-board-before-review.png"),
  mustExist("site/dist/assets/fictional-four-day-board-complete.png"),
]);

assert.equal(config.name, "otl1-site");
assert.equal(config.assets?.directory, "./dist");
assert.equal(config.assets?.binding, "ASSETS");
assert.equal(config.assets?.run_worker_first, true);
assert.equal(config.assets?.not_found_handling, "404-page");
assert.equal(config.services?.[0]?.binding, "CORE");
assert.notEqual(config.vars?.TURNSTILE_SITE_KEY, turnstileTestSiteKey, `${productionHostname} must not use the Cloudflare Turnstile test sitekey`);
assert.equal(config.vars?.TURNSTILE_SITE_KEY, turnstileProductionSiteKey, `${productionHostname} must use its hostname-scoped production sitekey`);

for (const fragment of [
  "default-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "Strict-Transport-Security",
  "X-Content-Type-Options",
  "Referrer-Policy",
]) assert.match(worker, new RegExp(fragment.replaceAll("'", "['\\']")));

for (const fragment of ["<main", "<nav", "<h1", "aria-expanded"]) {
  assert.ok(page.includes(fragment), `missing semantic markup: ${fragment}`);
}
assert.match(page, /<script src="\/boot\.js"><\/script>\s*<link rel="stylesheet"/, "mobile navigation must be enhanced before the first styled paint");

for (const fragment of [
  "오늘 가장 중요한 한 가지",
  "10:00",
  "18:00",
  "동료의 말",
  "필요할 때 먼저 건네는 도움",
  "서로 다른 하루가",
  "매일 제일 중요한 일 하나 정해서 같이 끝내는 모임이야. 같이 할래?",
  "각 회원에게 발급된 전용 링크",
]) assert.ok(documentText.includes(fragment), `missing semantic/story fragment: ${fragment}`);

assert.match(css, /prefers-reduced-motion:\s*reduce/);
assert.match(css, /:focus-visible/);
assert.doesNotMatch(css, /overflow-x:\s*clip/);
assert.match(script, /IntersectionObserver/);
assert.match(script, /classList\.add\("has-js"\)/);
assert.match(css, /\.has-js \.site-links/);
assert.match(page, /data-reaction-stage/);
assert.ok(page.indexOf("data-reaction-stage") < page.indexOf("class=\"garden-intro"), "reaction sprites must precede section text in the DOM");
assert.doesNotMatch(page, /stage-grid|stage-caption|confirm-complete\.gif|thumbs-up-cat\.png/);
assert.doesNotMatch(script, /thumbs-up-cat\.png/);
assert.match(css, /\.reaction-stage \{ position:absolute; inset:0; z-index:0; overflow:hidden; pointer-events:none/);
assert.match(css, /\.chapter--reactions > \.chapter-inner \{[^}]*z-index:1/);
assert.match(css, /\.rising-reactions \{[^}]*mask-image:/);
assert.equal((page.match(/class="daily-thread"/g) ?? []).length, 2, "the daily example must show distinct morning and evening root conversations");
assert.equal((page.match(/data-daily-row=/g) ?? []).length, 7, "the two conversations must retain all seven rows in DOM reading order");
assert.match(page, /10:00 · 오늘의 ONE THING/);
assert.match(page, /18:00 · 오늘의 돌아보기/);
assert.match(page, /가상 예시 · Slack에 전송되지 않습니다/);
assert.match(page, /data-daily-replay/);
assert.match(page, /data-daily-garden-cell/);
assert.match(page, /src="\/assets\/fictional-four-day-board-complete\.png"/);
assert.match(referral, /src="\/assets\/fictional-four-day-board-complete\.png"/);
assert.match(script, /beforeReview: "\/assets\/fictional-four-day-board-before-review\.png"/);
assert.match(script, /complete: "\/assets\/fictional-four-day-board-complete\.png"/);
assert.deepEqual([...beforeReviewBoard.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
assert.deepEqual([...completeBoard.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
assert.notDeepEqual(beforeReviewBoard, completeBoard, "replay needs distinct before-review and completed board images");
assert.doesNotMatch(page, /data-preview-state|data-preview-message|data-preview-cells/);
assert.match(referral, /<h1 id="home-title">초대받았어요!<\/h1>/);
assert.match(referral, /__INVITER_BYLINE__/);
assert.match(referral, /가상 예시 · Slack에 전송되지 않습니다/);
assert.match(referral, /data-reaction-stage/);
assert.equal((referral.match(/class="daily-thread"/g) ?? []).length, 2, "the referral page must reuse the two-root daily replay");
assert.equal((referral.match(/data-daily-row=/g) ?? []).length, 7, "the referral page must retain all replay rows");
assert.match(referral, /data-daily-replay/);
assert.match(referral, /data-daily-garden-cell/);
assert.match(referral, /주말 참여는 선택이에요/);
assert.match(referral, /필요할 때 먼저 건네는 도움/);
assert.doesNotMatch(referral, /referral-excerpt|\(invite-consent-v1\)/);
assert.match(referral, /name="consent" type="checkbox" value="invite-consent-v1" required/);
assert.match(page, /aria-live="polite"/);
assert.match(page, /DAY 4/);
assert.doesNotMatch(page, /thread-scene"[^>]*role="img"/);
assert.match(css, /@keyframes rise-reaction/);
assert.match(css, /reaction-stage\.is-paused \.rise/);
assert.match(css, /prefers-reduced-motion:reduce[^}]*\.has-motion \.rise/);
assert.match(script, /visibilitychange/);
assert.match(script, /event\.key !== "Escape"/);
assert.match(script, /setDailyGarden\(true\)/);
assert.match(css, /\.has-js:not\(\.prefers-reduced-motion\) \.daily-row:not\(\.is-visible\) \{ opacity:0; transform:/);
assert.doesNotMatch(script.slice(script.indexOf("const dailyReplay"), script.indexOf("window.addEventListener")), /fetch\(|XMLHttpRequest|sendBeacon/);
assert.match(css, /#home-title \{ font-size:var\(--display-mobile-section\); word-break:keep-all/);
assert.match(css, /body \{[^}]*word-break:keep-all/);
assert.match(css, /\.share-panel p\{(?=[^}]*word-break:keep-all)(?=[^}]*overflow-wrap:anywhere)/);
assert.match(css, /\.collective-board img \{[^}]*width:min\(100%,320px\)/);
assert.doesNotMatch(css, /\.grass(?:--|[.{:])/);
assert.doesNotMatch(css, /\.thread-scene|\.message--(?:goal|peer|support)|\.thread--(?:one|two)|\.mini-garden/);

for (const contents of [JSON.stringify(config), worker, page, referral, css, script]) {
  assert.doesNotMatch(contents, /ineffable/i);
  assert.doesNotMatch(contents, /(?:xox[baprs]-|postgres(?:ql)?:\/\/|neon\.tech|\bC[A-Z0-9]{8,}\b|\bU[A-Z0-9]{8,}\b)/);
  assert.doesNotMatch(contents, /\b[0-9a-f]{32}\b/);
}

console.log("PASS site static: two-root daily story, local replay isolation, referral routine, motion fallback, and secret guards");
