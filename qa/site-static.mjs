import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
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
const beforeReviewBoard = await readFile(
  resolve(root, "site/dist/assets/fictional-four-day-board-before-review.png"),
);
const completeBoard = await readFile(
  resolve(root, "site/dist/assets/fictional-four-day-board-complete.png"),
);
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
  mustExist("site/dist/assets/otl1-avatar.jpg"),
  mustExist("site/dist/assets/one-thing-korean-black.jpg"),
]);

assert.equal(config.name, "otl1-site");
assert.equal(config.assets?.directory, "./dist");
assert.equal(config.assets?.binding, "ASSETS");
assert.equal(config.assets?.run_worker_first, true);
assert.equal(config.assets?.not_found_handling, "404-page");
assert.equal(config.services?.[0]?.binding, "CORE");
assert.notEqual(
  config.vars?.TURNSTILE_SITE_KEY,
  turnstileTestSiteKey,
  `${productionHostname} must not use the Cloudflare Turnstile test sitekey`,
);
assert.equal(
  config.vars?.TURNSTILE_SITE_KEY,
  turnstileProductionSiteKey,
  `${productionHostname} must use its hostname-scoped production sitekey`,
);

for (const fragment of [
  "default-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "Strict-Transport-Security",
  "X-Content-Type-Options",
  "Referrer-Policy",
])
  assert.match(worker, new RegExp(fragment.replaceAll("'", "['\\']")));

for (const fragment of ["<main", "<nav", "<h1", "aria-expanded"]) {
  assert.ok(page.includes(fragment), `missing semantic markup: ${fragment}`);
}
assert.match(
  page,
  /<script src="\/boot\.js"><\/script>\s*<link rel="stylesheet"/,
  "mobile navigation must be enhanced before the first styled paint",
);

for (const fragment of [
  "ONE THING 1 LINE",
  "가장 중요한 업무 하나에 집중하는 모임",
  "오늘 가장 중요한 업무 하나를 함께 해냅니다.",
  "아침에 ONE THING을 정하고, 저녁에 완료 여부와 후기를 남깁니다.",
  "실제 진행 방식 보기",
  "게리 켈러·제이 파파산, 『원씽』",
  "하루 두 번, 목표와 결과를 한 문장씩 나눕니다.",
  "10:00",
  "18:00",
  "SET ONE THING",
  "DO ONE THING",
  "REVIEW ONE THING",
  "오늘의 ONE THING을 적습니다.",
  "ONE THING을 실행합니다.",
  "완료 여부와 후기를 남깁니다.",
  "함께 가면 더 멀리 갑니다. 기왕이면, 제대로 해내는 사람들과.",
  "검증된 사업가, 직장인, 학자들이 서로의 ONE THING을 응원하며 함께 성장합니다.",
  "신규 고객 인터뷰 3건 끝내기",
  "다음 주 발표 자료 첫 장 완성하기",
  "논문 서론 초안 마무리하기",
  "ONE THING 1 LINE은 신뢰하는 지인의 초대로만 함께할 수 있습니다.",
])
  assert.ok(documentText.includes(fragment), `missing semantic/story fragment: ${fragment}`);

assert.match(css, /prefers-reduced-motion:\s*reduce/);
assert.match(css, /:focus-visible/);
assert.doesNotMatch(css, /overflow-x:\s*clip/);
assert.match(script, /IntersectionObserver/);
assert.match(script, /classList\.add\("has-js"\)/);
assert.match(css, /\.has-js \.site-links/);
assert.match(page, /data-reaction-stage/);
assert.match(page, /src="\/assets\/otl1-avatar\.jpg"/);
assert.match(page, /src="\/assets\/one-thing-korean-black\.jpg"/);
assert.match(page, /href="https:\/\/product\.kyobobook\.co\.kr\/detail\/S000001619177"/);
assert.match(page, /후원|협찬/);
assert.equal((page.match(/class="stage-label"/g) ?? []).length, 3);
assert.equal((page.match(/class="clock-icon"/g) ?? []).length, 2);
assert.ok(
  page.indexOf("data-reaction-stage") < page.indexOf('class="garden-intro'),
  "reaction sprites must precede section text in the DOM",
);
assert.doesNotMatch(page, /stage-grid|stage-caption|confirm-complete\.gif|thumbs-up-cat\.png/);
assert.doesNotMatch(script, /thumbs-up-cat\.png/);
assert.match(
  css,
  /\.reaction-stage \{ position:absolute; inset:0; z-index:0; overflow:hidden; pointer-events:none/,
);
assert.match(css, /\.chapter--reactions > \.chapter-inner \{[^}]*z-index:1/);
assert.match(css, /\.rising-reactions \{[^}]*mask-image:/);
assert.equal(
  (page.match(/class="daily-thread"/g) ?? []).length,
  2,
  "the daily example must show distinct morning and evening root conversations",
);
assert.equal(
  (page.match(/data-daily-row=/g) ?? []).length,
  7,
  "the two conversations must retain all seven rows in DOM reading order",
);
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
assert.notDeepEqual(
  beforeReviewBoard,
  completeBoard,
  "replay needs distinct before-review and completed board images",
);
assert.doesNotMatch(page, /data-preview-state|data-preview-message|data-preview-cells/);
assert.match(referral, /<h1 id="home-title">초대받았어요!<\/h1>/);
assert.match(referral, /__INVITER_BYLINE__/);
assert.match(referral, /src="\/assets\/otl1-avatar\.jpg"/);
assert.match(referral, /SET ONE THING/);
assert.match(referral, /class="phrase-nowrap">더 멀리 갑니다\.<\/span>/);
assert.match(referral, /ONE THING이 매일의 기록으로 쌓이는 과정을 확인하세요\./);
assert.match(referral, /가상 예시 · Slack에 전송되지 않습니다/);
assert.match(referral, /data-reaction-stage/);
assert.equal(
  (referral.match(/class="daily-thread"/g) ?? []).length,
  2,
  "the referral page must reuse the two-root daily replay",
);
assert.equal(
  (referral.match(/data-daily-row=/g) ?? []).length,
  7,
  "the referral page must retain all replay rows",
);
assert.match(referral, /data-daily-replay/);
assert.match(referral, /data-daily-garden-cell/);
assert.doesNotMatch(referral, /referral-excerpt|\(invite-consent-v1\)/);
assert.match(referral, /name="consent" type="checkbox" value="invite-consent-v1" required/);
assert.match(referral, /Slack에서 함께하기/);
assert.match(referral, /class="slack-mark"[^>]*aria-hidden="true"/);
assert.ok(
  referral.indexOf("slack-join-button") < referral.indexOf('id="share-copy"'),
  "Slack participation must appear before the invite-copy panel",
);
assert.equal((referral.match(/id="share-copy"/g) ?? []).length, 1);
assert.doesNotMatch(referral, /name="displayName"|name="intent"|운영자가 직접 신청을 확인하고 승인|수동으로 보내/);
assert.match(script, /확인했습니다\. Slack을 열고 있어요\./);
assert.match(page, /aria-live="polite"/);
assert.match(page, /DAY 1–4/);
assert.doesNotMatch(page, /thread-scene"[^>]*role="img"/);
assert.doesNotMatch(page, /사람과 실천|함께 자라는 기록/);
assert.doesNotMatch(referral, /사람과 실천|함께 자라는 기록/);
assert.doesNotMatch(page, /초대 문구 미리보기|회원당 기본 초대 인원|회원별 전용 링크/);
assert.match(css, /@keyframes rise-reaction/);
assert.match(css, /reaction-stage\.is-paused \.rise/);
assert.match(css, /prefers-reduced-motion:reduce[^}]*\.has-motion \.rise/);
assert.match(script, /visibilitychange/);
assert.match(script, /dailyCompleteHold = 3000/);
assert.match(script, /dailyResetHold = 1000/);
assert.match(script, /intersectionRatio >= 0\.16/);
assert.match(script, /setDailyGarden\(true\)/);
assert.match(
  css,
  /\.has-js:not\(\.prefers-reduced-motion\) \.daily-row:not\(\.is-visible\) \{ opacity:0; transform:/,
);
assert.doesNotMatch(
  script.slice(script.indexOf("const dailyReplay"), script.indexOf("window.addEventListener")),
  /fetch\(|XMLHttpRequest|sendBeacon/,
);
assert.match(css, /#home-title \{ font-size:var\(--display-mobile-section\); word-break:keep-all/);
assert.match(css, /body \{[^}]*word-break:keep-all/);
assert.match(css, /\.share-panel p\{(?=[^}]*word-break:keep-all)(?=[^}]*overflow-wrap:anywhere)/);
assert.match(css, /\.daily-garden-board \{[^}]*width:100%/);
assert.doesNotMatch(css, /\.grass(?:--|[.{:])/);
assert.doesNotMatch(
  css,
  /\.thread-scene|\.message--(?:goal|peer|support)|\.thread--(?:one|two)|\.mini-garden/,
);

for (const contents of [JSON.stringify(config), worker, page, referral, css, script]) {
  assert.doesNotMatch(contents, /ineffable/i);
  assert.doesNotMatch(
    contents,
    /(?:xox[baprs]-|postgres(?:ql)?:\/\/|neon\.tech|\bC[A-Z0-9]{8,}\b|\bU[A-Z0-9]{8,}\b)/,
  );
  assert.doesNotMatch(contents, /\b[0-9a-f]{32}\b/);
}

console.log(
  "PASS site static: two-root daily story, local replay isolation, referral routine, motion fallback, and secret guards",
);
