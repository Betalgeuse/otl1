import { readFile, stat } from "node:fs/promises";
import assert from "node:assert/strict";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const read = async (path) => readFile(resolve(root, path), "utf8");
const mustExist = async (path) => stat(resolve(root, path));

const config = JSON.parse(await read("site/wrangler.jsonc"));
const worker = await read("site/src/index.ts");
const page = await read("site/dist/index.html");
const css = await read("site/dist/styles.css");
const script = await read("site/dist/app.js");
const observations = JSON.parse(await read(".omo/evidence/task-5-browser-observations.json"));
const documentText = page.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
const productionHostname = "otl1.hyuk.me";
const turnstileTestSiteKey = "1x00000000000000000000AA";
const turnstileProductionSiteKey = "0x4AAAAAAE83tTpMHyLr4nIv";

await Promise.all([
  mustExist("site/dist/404.html"),
  mustExist("site/dist/boot.js"),
  mustExist("site/DESIGN.md"),
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
assert.match(page, /data-preview-state="registration"/);
assert.match(page, /data-preview-state="completion"/);
assert.match(page, /data-preview-state="rest"/);
assert.match(page, /aria-live="polite"/);
assert.match(page, /DAY 4/);
assert.doesNotMatch(page, /thread-scene"[^>]*role="img"/);
assert.match(css, /@keyframes rise-reaction/);
assert.match(css, /reaction-stage\.is-paused \.rise/);
assert.match(css, /prefers-reduced-motion:reduce[^}]*\.has-motion \.rise/);
assert.match(script, /visibilitychange/);
assert.match(css, /#home-title \{ font-size:2\.45rem; word-break:keep-all/);
assert.match(css, /body \{[^}]*word-break:keep-all/);

const mobile = observations.viewports?.["320"];
assert.ok(mobile, "missing real 320px browser observation contract");
assert.equal(mobile.viewportWidth, 320);
for (const [name, measurement] of Object.entries(mobile.components ?? {})) {
  assert.ok(measurement.clientWidth >= measurement.scrollWidth, `${name} has intrinsic horizontal overflow`);
  assert.ok(measurement.left >= 0, `${name} extends left of the viewport`);
  assert.ok(measurement.right <= mobile.viewportWidth, `${name} extends right of the viewport`);
}
assert.deepEqual(mobile.visibleOverflow, [], "visible descendants exceed the 320px viewport");

for (const contents of [JSON.stringify(config), worker, page, css, script]) {
  assert.doesNotMatch(contents, /ineffable/i);
  assert.doesNotMatch(contents, /(?:xox[baprs]-|postgres(?:ql)?:\/\/|neon\.tech|\bC[A-Z0-9]{8,}\b|\bU[A-Z0-9]{8,}\b)/);
  assert.doesNotMatch(contents, /\b[0-9a-f]{32}\b/);
}

console.log("PASS site static: semantic story, isolation, motion fallback, and secret guards");
