import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";

const run = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const destination = join(tmpdir(), `otl1-guide-export-${randomUUID()}`);
const privateValues = [
  "1789721925.521149",
  "1789722193.000000",
  "F0C2S01GE06",
  "F0C2P2G2DFF",
  "fbef79eaf1840ee8e6c68fa203c2fbde2bbdba70a598cd1dcd23379d55c44b85",
];

function textFiles(directory) {
  const values = [];
  for (const name of readdirSync(directory)) {
    if (name === "node_modules") continue;
    const path = join(directory, name);
    if (statSync(path).isDirectory()) values.push(...textFiles(path));
    else values.push(path);
  }
  return values;
}

try {
  await run("bun", ["scripts/export-public.mjs", destination], { cwd: root, encoding: "utf8" });
  const config = JSON.parse(readFileSync(join(destination, "wrangler.jsonc"), "utf8"));
  assert.equal(config.account_id, undefined);
  assert.equal(config.vars.COMMUNITY_GUIDE_SOURCE_TS, "0.000001");
  assert.equal(config.vars.COMMUNITY_GUIDE_SOURCE_EDITED_TS, "0.000002");
  assert.equal(config.vars.COMMUNITY_GUIDE_FILE_IDS, "FREPLACELOGO,FREPLACEDAILY");
  assert.equal(config.vars.COMMUNITY_GUIDE_CONTENT_HASH, "0".repeat(64));
  assert.equal(existsSync(join(destination, ".github", "workflows")), false);
  const exportedText = textFiles(destination).map((path) => readFileSync(path, "utf8")).join("\n");
  for (const value of privateValues) assert.doesNotMatch(exportedText, new RegExp(value));
  console.log("PASS public welcome export uses placeholders, excludes private pins, and contains no GitHub Actions");
} finally {
  rmSync(destination, { recursive: true, force: true });
}
