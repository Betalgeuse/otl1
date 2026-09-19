import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const evidence = resolve(process.argv[2] ?? ".omo/evidence/site-reactions-browser");
mkdirSync(evidence, { recursive: true });
const session = "otl1-site-reactions-qa";
const browser = (...args) => {
  const result = spawnSync("agent-browser", ["--session", session, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`agent-browser ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
};
const evaluate = (expression) => JSON.parse(browser("eval", expression));
const results = [];
browser("open", "http://127.0.0.1:18765/");
for (const width of [320, 375, 768, 1440]) {
  browser("set", "viewport", String(width), "900");
  browser("reload");
  const measured = evaluate(`({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,clientWidth:document.documentElement.clientWidth,stageHeight:document.querySelector('.reaction-stage').getBoundingClientRect().height,sectionHeight:document.querySelector('#garden').getBoundingClientRect().height,stagePosition:getComputedStyle(document.querySelector('.reaction-stage')).position,stageFill:getComputedStyle(document.querySelector('.reaction-stage')).backgroundColor,stageBorder:getComputedStyle(document.querySelector('.reaction-stage')).borderTopWidth,stagePointer:getComputedStyle(document.querySelector('.reaction-stage')).pointerEvents,copyMask:getComputedStyle(document.querySelector('.rising-reactions')).maskImage,textLayer:getComputedStyle(document.querySelector('#garden > .chapter-inner')).zIndex,share:document.body.textContent.includes('매일 제일 중요한 일 하나 정해서 같이 끝내는 모임이야. 같이 할래?'),sections:[...document.querySelectorAll('main > section')].length,risingAssets:document.querySelectorAll('.rise').length})`);
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
  assert.equal(measured.share, true);
  assert.equal(measured.sections, 7);
  assert.equal(measured.risingAssets, 16);
  if (width === 375) {
    const playback = evaluate(`(async()=>{const stage=document.querySelector('.reaction-stage'); const sleep=()=>new Promise(r=>setTimeout(r,180)); const initial=stage.classList.contains('is-paused');stage.scrollIntoView({behavior:'instant'});await sleep();const onscreen=stage.classList.contains('is-paused');Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'));const hidden=stage.classList.contains('is-paused');Object.defineProperty(document,'hidden',{configurable:true,value:false});document.dispatchEvent(new Event('visibilitychange'));scrollTo({top:0,behavior:'instant'});await sleep();const offscreen=stage.classList.contains('is-paused');return {initial,onscreen,hidden,offscreen}})()`);
    assert.deepEqual(playback, { initial: true, onscreen: false, hidden: true, offscreen: true });
    results.push({ playback });
  }
  const edgeSample = evaluate(`(async()=>{const stage=document.querySelector('.reaction-stage');stage.scrollIntoView({behavior:'instant'});await new Promise(r=>setTimeout(r,180));const bounds=stage.getBoundingClientRect(),violations=[];for(const image of stage.querySelectorAll('.rise')){const animation=image.getAnimations()[0],duration=animation.effect.getTiming().duration;animation.pause();for(let percent=0;percent<=100;percent++){animation.currentTime=duration*percent/100;const opacity=Number(getComputedStyle(image).opacity),box=image.getBoundingClientRect();if(opacity>0.01&&(box.left<bounds.left-.5||box.right>bounds.right+.5||box.top<bounds.top-.5||box.bottom>bounds.bottom+.5))violations.push({src:image.getAttribute('src'),percent,opacity})}animation.play()}scrollTo({top:0,behavior:'instant'});return {sprites:stage.querySelectorAll('.rise').length,samplesPerSprite:101,violations}})()`);
  assert.equal(edgeSample.sprites, 16);
  assert.deepEqual(edgeSample.violations, [], `visible clipped sprite at ${width}`);
  results.push({ width, edgeSample });
  browser("eval", `(async()=>{for(const e of document.querySelectorAll('.reveal')){e.scrollIntoView();await new Promise(r=>setTimeout(r,120))}scrollTo(0,0);await new Promise(r=>setTimeout(r,700));return true})()`);
  browser("screenshot", "--full", resolve(evidence, `home-${width}.png`));
  for (const id of ["garden", "preview", "invitation", "collective"]) {
    browser("eval", `(async()=>{document.querySelector('#${id}').scrollIntoView({behavior:'instant'});await new Promise(r=>setTimeout(r,180));return true})()`);
    browser("screenshot", resolve(evidence, `${id}-${width}.png`));
  }
  results.push(measured);
}
browser("set", "viewport", "375", "900");
browser("eval", `document.querySelector('#preview').scrollIntoView({behavior:'instant'})`);
for (const state of ["registration", "completion", "rest"]) {
  browser("click", `[data-preview-state="${state}"]`);
  const stateResult = evaluate(`({selected:document.querySelector('[data-preview-state="${state}"]').getAttribute('aria-pressed'),message:document.querySelector('[data-preview-message]').textContent,announcement:document.querySelector('[data-preview-announcement]').textContent,reactions:[...document.querySelectorAll('[data-preview-reactions] img')].map(i=>i.getAttribute('src')),garden:document.querySelector('[data-preview-garden]').textContent})`);
  assert.equal(stateResult.selected, "true");
  assert.ok(stateResult.message.length > 10 && stateResult.announcement.includes(stateResult.message));
  assert.ok(stateResult.reactions.length > 0);
  assert.ok(stateResult.reactions.every((src) => src.startsWith("/assets/otl1-emoji/")));
  browser("screenshot", resolve(evidence, `preview-${state}-375.png`));
  results.push({ state, ...stateResult });
}
browser("focus", '[data-preview-state="registration"]');
browser("press", "Tab");
browser("press", "Enter");
assert.equal(evaluate(`document.querySelector('[data-preview-state="completion"]').getAttribute('aria-pressed')`), "true");
results.push({ keyboard: "Tab then Enter selected completion" });
browser("set", "media", "light", "reduced-motion");
browser("reload");
const reduced = evaluate(`({rise:[...document.querySelectorAll('.rise')].every(e=>getComputedStyle(e).display==='none'),static:getComputedStyle(document.querySelector('.still-reactions')).display,staticSources:[...document.querySelectorAll('.still-reactions img')].map(e=>e.getAttribute('src'))})`);
assert.equal(reduced.rise, true);
assert.equal(reduced.static, "block");
assert.equal(reduced.staticSources.length, 6);
assert.ok(reduced.staticSources.every((src) => src.endsWith(".png")));
browser("eval", `document.querySelector('#garden').scrollIntoView({behavior:'instant'})`);
browser("screenshot", resolve(evidence, "garden-reduced-375.png"));
results.push({ reduced });
browser("set", "media", "light");
browser("close");
writeFileSync(resolve(evidence, "results.json"), `${JSON.stringify({ pass: true, results }, null, 2)}\n`);
console.log(`PASS site browser scenarios: ${resolve(evidence, "results.json")}`);
