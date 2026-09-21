import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const evidence = resolve(process.argv[2] ?? ".omo/evidence/site-referral-parity-browser");
const origin = process.env.SITE_QA_ORIGIN ?? "http://127.0.0.1:18765";
const session = "otl1-site-referral-parity-qa";

mkdirSync(evidence, { recursive: true });

function browser(...args) {
  const result = spawnSync("agent-browser", ["--session", session, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`agent-browser ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

function evaluate(expression) {
  return JSON.parse(browser("eval", expression));
}

browser("open", `${origin}/r/${"A".repeat(32)}`);
browser("wait", "#home-title");
const results = [];
for (const width of [320, 375, 1440]) {
  browser("set", "viewport", String(width), "900");
  browser("reload");
  browser("wait", "#home-title");
  const page = evaluate(`(()=>({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,title:document.querySelector('#home-title')?.textContent?.trim(),byline:document.querySelector('.inviter-byline')?.textContent?.trim(),stages:document.querySelectorAll('[data-reaction-stage]').length,threads:document.querySelectorAll('.daily-thread').length,rows:document.querySelectorAll('[data-daily-row]').length,collective:new URL(document.querySelector('.collective-board img').src).pathname,consent:document.querySelector('input[name="consent"]')?.value,visibleConsent:document.querySelector('.consent')?.textContent?.includes('invite-consent-v1')}))()`);
  assert.equal(page.width, width);
  assert.equal(page.scrollWidth, width, `horizontal overflow at ${width}`);
  assert.equal(page.title, "초대받았어요!");
  assert.equal(page.byline, "지인의 소개로 이곳에 도착했어요.");
  assert.equal(page.stages, 1);
  assert.equal(page.threads, 2);
  assert.equal(page.rows, 7);
  assert.equal(page.collective, "/assets/fictional-four-day-board-complete.png");
  assert.equal(page.consent, "invite-consent-v1");
  assert.equal(page.visibleConsent, false);
  browser("screenshot", "--full", resolve(evidence, `referral-${width}.png`));
  results.push(page);
}

browser("set", "viewport", "375", "900");
browser("reload");
browser("eval", "document.querySelector('#preview').scrollIntoView({behavior:'instant'})");
const initial = evaluate(`new URL(document.querySelector('[data-daily-garden-cell]').src).pathname`);
assert.equal(initial, "/assets/fictional-four-day-board-before-review.png");
browser("press", "Tab");
browser("eval", "document.querySelector('[data-daily-replay]').click()");
browser("wait", '[data-daily-row="evening-peer"].is-visible');
const completed = evaluate(`new URL(document.querySelector('[data-daily-garden-cell]').src).pathname`);
assert.equal(completed, "/assets/fictional-four-day-board-complete.png");
browser("screenshot", resolve(evidence, "referral-replay-complete-375.png"));
browser("close");

writeFileSync(resolve(evidence, "referral-results.json"), `${JSON.stringify({ pass: true, results, initial, completed }, null, 2)}\n`);
console.log(`PASS referral browser parity: ${resolve(evidence, "referral-results.json")}`);
