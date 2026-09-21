import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const evidence = resolve(process.argv[2] ?? ".omo/evidence/site-reactions-browser");
mkdirSync(evidence, { recursive: true });
const session = "otl1-site-reactions-qa";
const origin = process.env.SITE_QA_ORIGIN ?? "http://127.0.0.1:18765";
const browser = (...args) => {
  const result = spawnSync("agent-browser", ["--session", session, ...args], { encoding: "utf8" });
  if (result.status !== 0)
    throw new Error(`agent-browser ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
};
const evaluate = (expression) => JSON.parse(browser("eval", expression));
const results = [];
browser("network", "unroute");
browser("set", "media", "light");
browser("open", `${origin}/`);
for (const width of [320, 375, 768, 1440]) {
  browser("set", "viewport", String(width), "900");
  browser("reload");
  browser("eval", "scrollTo({top:0,behavior:'instant'})");
  browser("eval", "new Promise(resolve=>setTimeout(resolve,120))");
  const measured = evaluate(
    `(()=>{const tags=[...document.querySelectorAll('.daily-thread-heading p')];const wordmark=document.querySelector('.wordmark span'),brand=document.querySelector('.brand-lockup');return {width:innerWidth,scrollWidth:document.documentElement.scrollWidth,clientWidth:document.documentElement.clientWidth,stageHeight:document.querySelector('.reaction-stage').getBoundingClientRect().height,sectionHeight:document.querySelector('#garden').getBoundingClientRect().height,stagePosition:getComputedStyle(document.querySelector('.reaction-stage')).position,stageFill:getComputedStyle(document.querySelector('.reaction-stage')).backgroundColor,stageBorder:getComputedStyle(document.querySelector('.reaction-stage')).borderTopWidth,stagePointer:getComputedStyle(document.querySelector('.reaction-stage')).pointerEvents,copyMask:getComputedStyle(document.querySelector('.rising-reactions')).maskImage,textLayer:getComputedStyle(document.querySelector('#garden > .chapter-inner')).zIndex,invitation:document.body.textContent.includes('ONE THING 1 LINE은 신뢰하는 지인의 초대로만 함께할 수 있습니다.'),sections:[...document.querySelectorAll('main > section')].length,risingAssets:document.querySelectorAll('.rise').length,stageLabels:document.querySelectorAll('.stage-label').length,clockIcons:document.querySelectorAll('.clock-icon').length,wordmarkLines:(()=>{const r=document.createRange();r.selectNodeContents(wordmark);return r.getClientRects().length})(),brandOneLine:(()=>{const parts=[...brand.children].map(e=>e.getBoundingClientRect());return Math.abs(parts[0].top-parts[1].top)<1})(),logoLoaded:document.querySelector('.wordmark img').naturalWidth===512,bookLoaded:document.querySelector('.book-card img').naturalWidth===1000,channelLines:tags.map(tag=>{const range=document.createRange();range.selectNodeContents(tag);return range.getClientRects().length})}})()`,
  );
  assert.equal(measured.width, width);
  assert.equal(measured.scrollWidth, width, `horizontal overflow at ${width}`);
  assert.equal(measured.clientWidth, width);
  assert.equal(measured.stageHeight, measured.sectionHeight);
  assert.equal(measured.stagePosition, "absolute");
  assert.equal(measured.stageFill, "rgba(0, 0, 0, 0)");
  assert.equal(measured.stageBorder, "0px");
  assert.equal(measured.stagePointer, "none");
  assert.notEqual(measured.copyMask, "none");
  assert.equal(measured.textLayer, "1");
  assert.equal(measured.invitation, true);
  assert.equal(measured.sections, 5);
  assert.equal(measured.risingAssets, 16);
  assert.equal(measured.stageLabels, 3);
  assert.equal(measured.clockIcons, 2);
  assert.equal(measured.wordmarkLines, 1);
  assert.equal(measured.brandOneLine, true);
  assert.equal(measured.logoLoaded, true);
  assert.equal(measured.bookLoaded, true);
  assert.deepEqual(
    measured.channelLines,
    [1, 1],
    `daily-scrum channel tags must remain one line at ${width}`,
  );
  if (width === 375) {
    const playback = evaluate(
      `(async()=>{const stage=document.querySelector('.reaction-stage'); const sleep=()=>new Promise(r=>setTimeout(r,180)); const initial=stage.classList.contains('is-paused');stage.scrollIntoView({behavior:'instant'});await sleep();const onscreen=stage.classList.contains('is-paused');Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'));const hidden=stage.classList.contains('is-paused');Object.defineProperty(document,'hidden',{configurable:true,value:false});document.dispatchEvent(new Event('visibilitychange'));scrollTo({top:0,behavior:'instant'});await sleep();const offscreen=stage.classList.contains('is-paused');return {initial,onscreen,hidden,offscreen}})()`,
    );
    assert.deepEqual(playback, { initial: true, onscreen: false, hidden: true, offscreen: true });
    results.push({ playback });
  }
  const edgeSample = evaluate(
    `(async()=>{const stage=document.querySelector('.reaction-stage');stage.scrollIntoView({behavior:'instant'});await new Promise(r=>setTimeout(r,180));const bounds=stage.getBoundingClientRect(),violations=[];for(const image of stage.querySelectorAll('.rise')){const animation=image.getAnimations()[0],duration=animation.effect.getTiming().duration;animation.pause();for(let percent=0;percent<=100;percent++){animation.currentTime=duration*percent/100;const opacity=Number(getComputedStyle(image).opacity),box=image.getBoundingClientRect();if(opacity>0.01&&(box.left<bounds.left-.5||box.right>bounds.right+.5||box.top<bounds.top-.5||box.bottom>bounds.bottom+.5))violations.push({src:image.getAttribute('src'),percent,opacity})}animation.play()}scrollTo({top:0,behavior:'instant'});return {sprites:stage.querySelectorAll('.rise').length,samplesPerSprite:101,violations}})()`,
  );
  assert.equal(edgeSample.sprites, 16);
  assert.deepEqual(edgeSample.violations, [], `visible clipped sprite at ${width}`);
  results.push({ width, edgeSample });
  browser(
    "eval",
    `(async()=>{const reveals=[...document.querySelectorAll('.reveal')];for(const e of reveals){e.scrollIntoView();await new Promise(r=>setTimeout(r,700))}if(reveals.some(e=>!e.classList.contains('is-visible')))throw new Error('reveal did not settle');document.activeElement?.blur();scrollTo(0,0);await new Promise(r=>setTimeout(r,700));return true})()`,
  );
  browser("screenshot", "--full", resolve(evidence, `home-${width}.png`));
  for (const id of ["rhythm", "garden", "preview", "invitation"]) {
    browser(
      "eval",
      `(async()=>{document.querySelector('#${id}').scrollIntoView({behavior:'instant'});await new Promise(r=>setTimeout(r,180));return true})()`,
    );
    browser("screenshot", resolve(evidence, `${id}-${width}.png`));
  }
  results.push(measured);
}
browser("set", "viewport", "375", "900");
browser("reload");
browser("eval", "scrollTo({top:0,behavior:'instant'})");
browser("eval", `document.querySelector('#preview').scrollIntoView({behavior:'instant'})`);
browser("wait", '[data-daily-row="ack"].is-visible');
const initialPreview = evaluate(
  `({visible:[...document.querySelectorAll('[data-daily-row]')].filter(row=>row.classList.contains('is-visible')).map(row=>row.dataset.dailyRow),board:new URL(document.querySelector('[data-daily-garden-cell]').src).pathname,button:document.querySelector('[data-daily-replay]').textContent.trim()})`,
);
assert.deepEqual(initialPreview, {
  visible: ["goal", "ack"],
  board: "/assets/fictional-four-day-board-before-review.png",
  button: "일시정지",
});
const resourcesBeforeReplay = evaluate(`performance.getEntriesByType('resource').length`);
browser("wait", '[data-daily-row="evening-peer"].is-visible');
const completedPreview = evaluate(
  `({visible:[...document.querySelectorAll('[data-daily-row]')].filter(row=>row.classList.contains('is-visible')).map(row=>row.dataset.dailyRow),board:new URL(document.querySelector('[data-daily-garden-cell]').src).pathname,copy:document.querySelector('[data-daily-garden-copy]').textContent.trim(),button:document.querySelector('[data-daily-replay]').textContent.trim(),announcement:document.querySelector('[data-daily-announcement]').textContent.trim(),slackWrites:performance.getEntriesByType('resource').slice(${resourcesBeforeReplay}).filter(entry=>/slack\\.com/.test(entry.name)).length})`,
);
assert.deepEqual(completedPreview.visible, [
  "goal",
  "ack",
  "morning-peer",
  "review-prompt",
  "reflection",
  "completion",
  "evening-peer",
]);
assert.equal(completedPreview.board, "/assets/fictional-four-day-board-complete.png");
assert.equal(completedPreview.copy, "DAY 1–3 · 완료 체크, DAY 4 · 예정");
assert.equal(completedPreview.button, "일시정지");
assert.equal(completedPreview.announcement, "");
assert.equal(completedPreview.slackWrites, 0);
browser("screenshot", resolve(evidence, "preview-complete-375.png"));
browser("eval", "new Promise(resolve => setTimeout(resolve, 3500))");
const resetPreview = evaluate(
  `({visible:[...document.querySelectorAll('[data-daily-row]')].filter(row=>row.classList.contains('is-visible')).map(row=>row.dataset.dailyRow),board:new URL(document.querySelector('[data-daily-garden-cell]').src).pathname})`,
);
assert.deepEqual(resetPreview, {
  visible: [],
  board: "/assets/fictional-four-day-board-before-review.png",
});
browser("wait", '[data-daily-row="ack"].is-visible');
const secondCycle = evaluate(
  `({visible:[...document.querySelectorAll('[data-daily-row]')].filter(row=>row.classList.contains('is-visible')).map(row=>row.dataset.dailyRow),board:new URL(document.querySelector('[data-daily-garden-cell]').src).pathname})`,
);
assert.deepEqual(secondCycle, {
  visible: ["goal", "ack"],
  board: "/assets/fictional-four-day-board-before-review.png",
});
results.push({ initialPreview, completedPreview, resetPreview, secondCycle });
browser("reload");
browser("eval", `document.querySelector('#preview').scrollIntoView({behavior:'instant'})`);
browser("wait", '[data-daily-row="ack"].is-visible');
const pausedByVisibility = evaluate(
  `(async()=>{const rows=()=>[...document.querySelectorAll('[data-daily-row]')].filter(row=>row.classList.contains('is-visible')).map(row=>row.dataset.dailyRow);Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'));const paused=rows();await new Promise(resolve=>setTimeout(resolve,3900));const held=rows();Object.defineProperty(document,'hidden',{configurable:true,value:false});document.dispatchEvent(new Event('visibilitychange'));await new Promise(resolve=>setTimeout(resolve,520));return {paused,held,resumed:rows(),board:new URL(document.querySelector('[data-daily-garden-cell]').src).pathname}})()`,
);
assert.deepEqual(pausedByVisibility, {
  paused: ["goal", "ack"],
  held: ["goal", "ack"],
  resumed: ["goal", "ack"],
  board: "/assets/fictional-four-day-board-before-review.png",
});
browser("eval", "scrollTo({top:0,behavior:'instant'})");
const pausedOffscreen = evaluate(
  `(async()=>{const rows=()=>[...document.querySelectorAll('[data-daily-row]')].filter(row=>row.classList.contains('is-visible')).map(row=>row.dataset.dailyRow);const paused=rows();await new Promise(resolve=>setTimeout(resolve,3900));return {paused,held:rows(),board:new URL(document.querySelector('[data-daily-garden-cell]').src).pathname}})()`,
);
assert.deepEqual(pausedOffscreen, {
  paused: ["goal", "ack"],
  held: ["goal", "ack"],
  board: "/assets/fictional-four-day-board-before-review.png",
});
results.push({ pausedByVisibility, pausedOffscreen });
const referralToken = "A".repeat(32);
for (const width of [320, 375, 768, 1440]) {
  browser("set", "viewport", String(width), "900");
  browser("open", `${origin}/r/${referralToken}`);
  browser(
    "eval",
    `(async()=>{const reveals=[...document.querySelectorAll('.reveal')];for(const e of reveals){e.scrollIntoView({behavior:'instant'});await new Promise(r=>setTimeout(r,700))}if(reveals.some(e=>!e.classList.contains('is-visible')))throw new Error('referral reveal did not settle');scrollTo({top:0,behavior:'instant'});await new Promise(r=>setTimeout(r,180));return true})()`,
  );
  const referral = evaluate(
    `(()=>{const wordmark=document.querySelector('.wordmark span');const range=document.createRange();range.selectNodeContents(wordmark);return {width:innerWidth,scrollWidth:document.documentElement.scrollWidth,clientWidth:document.documentElement.clientWidth,title:document.querySelector('h1')?.textContent.trim(),sections:document.querySelectorAll('main > section').length,wordmarkLines:range.getClientRects().length,logoLoaded:document.querySelector('.wordmark img')?.naturalWidth===512,stageLabels:document.querySelectorAll('.stage-label').length,clocks:document.querySelectorAll('.clock-icon').length,threads:document.querySelectorAll('.daily-thread').length,boardLoaded:document.querySelector('[data-daily-garden-cell]')?.naturalWidth===640,formAction:document.querySelector('[data-application-form]')?.getAttribute('action'),fields:[...document.querySelectorAll('[data-application-form] [name]')].map(e=>e.getAttribute('name')),placeholderLeak:document.body.textContent.includes('__')}})()`,
  );
  assert.equal(referral.width, width);
  assert.equal(referral.scrollWidth, width, `referral horizontal overflow at ${width}`);
  assert.equal(referral.clientWidth, width);
  assert.equal(referral.title, "초대받았어요!");
  assert.equal(referral.sections, 5);
  assert.equal(referral.wordmarkLines, 1);
  assert.equal(referral.logoLoaded, true);
  assert.equal(referral.stageLabels, 3);
  assert.equal(referral.clocks, 2);
  assert.equal(referral.threads, 2);
  assert.equal(referral.boardLoaded, true);
  assert.equal(referral.formAction, `/r/${referralToken}/apply`);
  assert.deepEqual(referral.fields.slice(0, 5), ["submissionKey", "email", "displayName", "intent", "consent"]);
  assert.equal(referral.placeholderLeak, false);
  browser("screenshot", "--full", resolve(evidence, `referral-${width}.png`));
  results.push({ referral });
}
browser("set", "viewport", "375", "900");
browser("set", "media", "light", "reduced-motion");
browser("reload");
const reduced = evaluate(
  `({rise:[...document.querySelectorAll('.rise')].every(e=>getComputedStyle(e).display==='none'),static:getComputedStyle(document.querySelector('.still-reactions')).display,staticSources:[...document.querySelectorAll('.still-reactions img')].map(e=>e.getAttribute('src')),visibleRows:[...document.querySelectorAll('[data-daily-row]')].filter(row=>row.classList.contains('is-visible')).length,board:new URL(document.querySelector('[data-daily-garden-cell]').src).pathname})`,
);
assert.equal(reduced.rise, true);
assert.equal(reduced.static, "block");
assert.equal(reduced.staticSources.length, 6);
assert.ok(reduced.staticSources.every((src) => src.endsWith(".png")));
assert.equal(reduced.visibleRows, 7);
assert.equal(reduced.board, "/assets/fictional-four-day-board-complete.png");
browser("eval", `document.querySelector('#garden').scrollIntoView({behavior:'instant'})`);
browser("screenshot", resolve(evidence, "garden-reduced-375.png"));
results.push({ reduced });
browser("set", "media", "light");
browser("network", "route", "**/app.js", "--abort");
browser("network", "route", "**/boot.js", "--abort");
browser("open", `${origin}/`);
const noScript = evaluate(
  `({hasJs:document.documentElement.classList.contains('has-js'),overflow:document.documentElement.scrollWidth-document.documentElement.clientWidth,links:getComputedStyle(document.querySelector('.site-links')).display,visibleRows:[...document.querySelectorAll('[data-daily-row]')].every(row=>getComputedStyle(row).opacity==='1'),board:new URL(document.querySelector('[data-daily-garden-cell]').src).pathname})`,
);
assert.deepEqual(noScript, {
  hasJs: false,
  overflow: 0,
  links: "grid",
  visibleRows: true,
  board: "/assets/fictional-four-day-board-complete.png",
});
browser("screenshot", "--full", resolve(evidence, "home-no-script-375.png"));
results.push({ noScript });
browser("network", "unroute");
browser("close");
writeFileSync(
  resolve(evidence, "results.json"),
  `${JSON.stringify({ pass: true, results }, null, 2)}\n`,
);
console.log(`PASS site browser scenarios: ${resolve(evidence, "results.json")}`);
