import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  cpSync,
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const destination = join(tmpdir(), `otl1-guide-export-${randomUUID()}`);
const sourceGuideIds = JSON.parse(readFileSync(join(root, "wrangler.jsonc"), "utf8"))
  .vars.COMMUNITY_GUIDE_FILE_IDS.split(",")
  .filter((id) => !id.startsWith("FREPLACE"));
const sourceChapterIds = JSON.parse(
  readFileSync(join(root, "wrangler.jsonc"), "utf8"),
).vars.COMMUNITY_GUIDE_CHAPTER_CHANNEL_IDS.split(",");
const unsafeGuideFixtures = [
  "CFAKEGUIDE123",
  "FFAKEGUIDE123",
  ["https://", "example", ".slack.com/archives/CFAKEGUIDE123/p1234567890000000"].join(""),
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
      run("bun", ["scripts/export-public.mjs", fixtureDestination], {
        cwd: fixtureRoot,
        encoding: "utf8",
      }),
      (error) => {
        assert.match(
          error.stderr,
          /Public welcome guide source contains a live Slack identifier or workspace URL/,
        );
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
  for (const unsafe of unsafeGuideFixtures)
    await assertUnsafeGuideSourceRefusesBeforeOutput(unsafe);
  for (const source of lifecycleAdminSources) await assertMissingSourceRefusesBeforeOutput(source);
  await run("bun", ["scripts/export-public.mjs", destination], { cwd: root, encoding: "utf8" });
  const config = JSON.parse(readFileSync(join(destination, "wrangler.jsonc"), "utf8"));
  assert.equal(config.account_id, undefined);
  assert.equal(config.vars.COMMUNITY_GUIDE_FILE_IDS, "FREPLACELOGO,FREPLACEDAILY");
  assert.equal(
    config.vars.COMMUNITY_GUIDE_CHAPTER_CHANNEL_IDS,
    "C_REPLACE_DEVELOPERS,C_REPLACE_ENGLISH,C_REPLACE_INVESTMENT",
  );
  assert.equal(config.vars.COMMUNITY_GUIDE_CANVAS_ID, "FREPLACECANVAS");
  assert.equal(
    config.vars.COMMUNITY_GUIDE_CANVAS_URL,
    "https://example.slack.com/docs/TREPLACE/FREPLACECANVAS",
  );
  assert.equal(config.vars.COMMUNITY_GUIDE_ANCHOR_TS, "1000000000.000000");
  assert.equal(
    config.vars.COMMUNITY_CHAPTER_CHANNEL_IDS,
    "C_REPLACE_DEVELOPERS,C_REPLACE_ENGLISH,C_REPLACE_INVESTMENT,C_REPLACE_SCIENTIST",
  );
  assert.equal(existsSync(join(destination, "migrations", "028_welcome_guide_roles.sql")), true);
  assert.equal(
    existsSync(join(destination, "migrations", "039_bot_owned_welcome_guide.sql")),
    true,
  );
  assert.equal(existsSync(join(destination, "src", "community-guide-release.ts")), true);
  assert.equal(existsSync(join(destination, "scripts", "bootstrap-guide-db-roles.mjs")), true);
  for (const source of lifecycleAdminSources)
    assert.equal(
      readFileSync(join(destination, source), "utf8"),
      readFileSync(join(root, source), "utf8"),
    );
  assert.match(
    readFileSync(join(destination, ".dev.vars.example"), "utf8"),
    /^LIFECYCLE_ADMIN_DATABASE_URL=$/m,
  );
  assert.equal(existsSync(join(destination, ".github", "workflows")), false);
  const exportedText = textFiles(destination)
    .map((path) => readFileSync(path, "utf8"))
    .join("\n");
  for (const value of sourceGuideIds) assert.doesNotMatch(exportedText, new RegExp(value));
  for (const value of sourceChapterIds) assert.doesNotMatch(exportedText, new RegExp(value));
  const workspaceLinks = [
    ...exportedText.matchAll(/https:\/\/([a-z0-9-]+)\.slack\.com\/archives\//g),
  ].filter((match) => !["test", "example"].includes(match[1]));
  assert.equal(workspaceLinks.length, 0, "public export contains a workspace permalink");
  console.log(
    "PASS public welcome export rejects live C/F IDs and Slack URLs, uses private image placeholders, and contains no GitHub Actions",
  );
} finally {
  rmSync(destination, { recursive: true, force: true });
}
