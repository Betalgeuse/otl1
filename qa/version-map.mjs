import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const roadmap = readFileSync(resolve(root, "docs/ROADMAP.md"), "utf8");
const history = readFileSync(resolve(root, "docs/UPDATE_HISTORY.md"), "utf8");
const required = [
  ["v0.0.56", "검토 스레드"],
  ["v0.0.57", "계절 잔디"],
  ["v0.0.58", "shadow"],
  ["v0.0.59", "유예"],
  ["v0.0.60", "시즌 종료"],
  ["v0.0.61", "ONE THING 복귀"],
  ["v0.0.62", "소개 신청"],
  ["v0.0.63", "비공개 승인"],
  ["v0.0.64", "공개 사이트"],
];

function activeRows(document) {
  return [...document.matchAll(/^\| (v0\.0\.\d+) \| ([^|]+) \|/gm)].map((match) => [match[1], match[2]]);
}

function assertRoadmap(document) {
  const rows = activeRows(document);
  for (const [version, outcome] of required) {
    const matches = rows.filter(([candidate]) => candidate === version);
    assert.equal(matches.length, 1, `${version} must have one active roadmap outcome`);
    assert.match(matches[0][1], new RegExp(outcome));
  }
  assert.match(document, /모든 v0\.0\.56–v0\.0\.64는 미출시 계획/);
  assert.match(document, /7개.*관측.*평일/);
  assert.match(document, /7일.*유예/);
  assert.match(document, /사유.*7일.*연장/);
  assert.match(document, /Slack.*강퇴|강퇴.*Slack/);
  assert.match(document, /새.*ONE THING.*복귀|ONE THING.*새.*복귀/);
  assert.match(document, /소개자는.*권한.*없|소개자.*권한.*없/);
}

function assertHistory(document) {
  assert.match(document, /현재 운영 기능 기준은 \*\*v0\.0\.55\*\*/);
  assert.match(document, /## 2026-09-19 미출시 회원·소개 릴리스 재정렬/);
  for (const [version] of required) assert.match(document, new RegExp(`\\| ${version} \\|`));
  assert.match(document, /이전 계획.*현재 계획/);
}

assertRoadmap(roadmap);
assertHistory(history);

assert.throws(() => assertRoadmap(roadmap.replace("| v0.0.64 |", "| v0.0.56 |")));
assert.throws(() => assertRoadmap(roadmap.replace("7개", "30개")));
assert.throws(() => assertHistory(history.replace("미출시 회원·소개 릴리스 재정렬", "다른 제목")));

console.log("PASS version map keeps one planned membership outcome per v0.0.56-v0.0.64 and preserves release lineage");
