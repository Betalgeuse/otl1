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

await Promise.all([
  mustExist("site/dist/404.html"),
  mustExist("site/DESIGN.md"),
]);

assert.equal(config.name, "otl1-site");
assert.equal(config.assets?.directory, "./dist");
assert.equal(config.assets?.binding, "ASSETS");
assert.equal(config.assets?.run_worker_first, true);
assert.equal(config.assets?.not_found_handling, "404-page");
assert.equal(config.services?.[0]?.binding, "CORE");
assert.equal(config.vars?.TURNSTILE_SITE_KEY, "1x00000000000000000000AA");

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

for (const fragment of [
  "오늘 가장 중요한 한 가지",
  "10:00",
  "18:00",
  "동료의 반응",
  "먼저 다가가는 도움",
  "언제든 돌아올 수 있습니다",
]) assert.ok(documentText.includes(fragment), `missing semantic/story fragment: ${fragment}`);

assert.match(css, /prefers-reduced-motion:\s*reduce/);
assert.match(css, /:focus-visible/);
assert.doesNotMatch(css, /overflow-x:\s*clip/);
assert.match(script, /IntersectionObserver/);
assert.match(script, /classList\.add\("has-js"\)/);
assert.match(css, /\.has-js \.site-links/);
assert.match(page, /<article class="message message--goal">/);
assert.doesNotMatch(page, /thread-scene"[^>]*role="img"/);
assert.doesNotMatch(css, /animation:\s*[^;]*infinite/);
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
