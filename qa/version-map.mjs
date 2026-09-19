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
  ["v0.0.62", "초대 한도"],
  ["v0.0.63", "비공개 참여 문의"],
  ["v0.0.64", "소개 신청"],
  ["v0.0.65", "비공개 승인"],
  ["v0.0.66", "공개 사이트"],
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
  assert.match(document, /모든 v0\.0\.56–v0\.0\.66는 미출시 계획/);
  assert.match(document, /7개.*관측.*평일/);
  assert.match(document, /7일.*유예/);
  assert.match(document, /사유.*7일.*연장/);
  assert.match(document, /Slack.*강퇴|강퇴.*Slack/);
  assert.match(document, /새.*ONE THING.*복귀|ONE THING.*새.*복귀/);
  assert.match(document, /소개자는.*권한.*없|소개자.*권한.*없/);
  assert.match(document, /기본.*2명|기본.*2/);
  assert.match(document, /가입.*승인.*예약|승인.*가입.*예약/);
  assert.match(document, /pending.*소개 신청|관심 문의.*예약.*않/);
  assert.match(document, /interest-consent-v1/);
  assert.match(document, /invite-consent-v1/);
  assert.match(document, /서명.*활성 회원.*확인|활성 회원.*서명.*확인/);
}

function assertHistory(document) {
  assert.match(document, /현재 운영 기능 기준은 \*\*v0\.0\.55\*\*/);
  assert.match(document, /## 2026-09-20 미출시 초대 한도·관심 문의 삽입 재정렬/);
  for (const [version] of required) assert.match(document, new RegExp(`\\| ${version} \\|`));
  assert.match(document, /이전 계획.*현재 계획/);
  assert.match(document, /\| v0\.0\.62 \| v0\.0\.64 \|/);
  assert.match(document, /\| v0\.0\.63 \| v0\.0\.65 \|/);
  assert.match(document, /\| v0\.0\.64 \| v0\.0\.66 \|/);
}

assertRoadmap(roadmap);
assertHistory(history);

assert.throws(() => assertRoadmap(roadmap.replace("| v0.0.66 |", "| v0.0.56 |")));
assert.throws(() => assertRoadmap(roadmap.replace("7개", "30개")));
assert.throws(() => assertHistory(history.replace("미출시 초대 한도·관심 문의 삽입 재정렬", "다른 제목")));

console.log("PASS version map keeps one planned membership outcome per v0.0.56-v0.0.66 and preserves release lineage");
