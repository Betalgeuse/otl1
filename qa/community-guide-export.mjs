import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, cpSync, existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const destination = join(tmpdir(), `otl1-guide-export-${randomUUID()}`);
const privateValues = [
  "1789721925.521149",
  "F0C2S01GE06",
  "F0C2P2G2DFF",
  "onething1line.slack.com",
  "1789722193.000000",
  "fbef79eaf1840ee8e6c68fa203c2fbde2bbdba70a598cd1dcd23379d55c44b85",
];
const lifecycleAdminSources = [
  "migrations/035_lifecycle_admin_login.sql",
  "scripts/bootstrap-lifecycle-admin-db-role.mjs",
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

async function assertMissingSourceRefusesBeforeOutput(source) {
  const fixtureRoot = join(tmpdir(), `otl1-guide-export-source-${randomUUID()}`);
  const fixtureDestination = join(tmpdir(), `otl1-guide-export-missing-${randomUUID()}`);
  try {
    cpSync(root, fixtureRoot, {
      recursive: true,
      filter: (path) => ![".git", ".omo", ".output", "node_modules"].includes(basename(path)),
    });
    rmSync(join(fixtureRoot, source));
    await assert.rejects(
      run("bun", ["scripts/export-public.mjs", fixtureDestination], {
        cwd: fixtureRoot,
        encoding: "utf8",
      }),
      (error) => {
        assert.match(error.stderr, new RegExp(`Missing required public export source: ${source}`));
        return true;
      },
    );
    assert.equal(existsSync(fixtureDestination), false);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
    rmSync(fixtureDestination, { recursive: true, force: true });
  }
}

async function assertUnsafeGuideSourceRefusesBeforeOutput(markerText) {
  const fixtureRoot = join(tmpdir(), `otl1-guide-export-unsafe-${randomUUID()}`);
  const fixtureDestination = join(tmpdir(), `otl1-guide-export-blocked-${randomUUID()}`);
  try {
    cpSync(root, fixtureRoot, {
      recursive: true,
      filter: (path) => ![".git", ".omo", ".output", "node_modules"].includes(basename(path)),
    });
    appendFileSync(join(fixtureRoot, "src/community-guide-release.ts"), `\n// ${markerText}\n`);
    await assert.rejects(
      run("bun", ["scripts/export-public.mjs", fixtureDestination], { cwd: fixtureRoot, encoding: "utf8" }),
      (error) => {
        assert.match(error.stderr, /Public welcome guide source contains a live Slack identifier or workspace URL/);
        return true;
      },
    );
    assert.equal(existsSync(fixtureDestination), false);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
    rmSync(fixtureDestination, { recursive: true, force: true });
  }
}

try {
  for (const unsafe of ["C0BVB9HSL10", "F0C2S01GE06", "https://onething1line.slack.com/archives/C0BVB9HSL10/p1234567890000000"])
    await assertUnsafeGuideSourceRefusesBeforeOutput(unsafe);
  for (const source of lifecycleAdminSources) await assertMissingSourceRefusesBeforeOutput(source);
  await run("bun", ["scripts/export-public.mjs", destination], { cwd: root, encoding: "utf8" });
  const config = JSON.parse(readFileSync(join(destination, "wrangler.jsonc"), "utf8"));
  assert.equal(config.account_id, undefined);
  assert.equal(config.vars.COMMUNITY_GUIDE_FILE_IDS, "FREPLACELOGO,FREPLACEDAILY");
  assert.equal(existsSync(join(destination, "migrations", "028_welcome_guide_roles.sql")), true);
  assert.equal(existsSync(join(destination, "migrations", "039_bot_owned_welcome_guide.sql")), true);
  assert.equal(existsSync(join(destination, "src", "community-guide-release.ts")), true);
  assert.equal(existsSync(join(destination, "scripts", "bootstrap-guide-db-roles.mjs")), true);
  for (const source of lifecycleAdminSources)
    assert.equal(readFileSync(join(destination, source), "utf8"), readFileSync(join(root, source), "utf8"));
  assert.match(readFileSync(join(destination, ".dev.vars.example"), "utf8"), /^LIFECYCLE_ADMIN_DATABASE_URL=$/m);
  assert.equal(existsSync(join(destination, ".github", "workflows")), false);
  const exportedText = textFiles(destination)
    .map((path) => readFileSync(path, "utf8"))
    .join("\n");
  for (const value of privateValues) assert.doesNotMatch(exportedText, new RegExp(value));
  console.log(
    "PASS public welcome export rejects live C/F IDs and Slack URLs, uses private image placeholders, and contains no GitHub Actions",
  );
} finally {
  rmSync(destination, { recursive: true, force: true });
}
