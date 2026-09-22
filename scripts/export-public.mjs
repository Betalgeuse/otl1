import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertSanitizedCoreConfig,
  assertPublicGuideReleaseSource,
  sanitizePackageMetadata,
  sanitizeSiteQaCoreConfig,
  sanitizeSiteWranglerConfig,
  sanitizeWranglerConfig,
} from "./export-public-config.mjs";
import {
  assertPublicExportPaths,
  assertRequiredPublicExportSources,
  PUBLIC_DOC_NAMES,
  PUBLIC_QA_NAMES,
  PUBLIC_COPY_PATHS,
  PUBLIC_REQUIRED_EXPORT_SOURCES,
  PUBLIC_RUNTIME_MIGRATION_PATHS,
} from "./export-public-manifest.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const destination = resolve(process.argv[2] ?? "/tmp/otl1-public");
const marker = join(destination, ".public-export");
assertRequiredPublicExportSources(
  PUBLIC_REQUIRED_EXPORT_SOURCES,
  (path) => existsSync(join(root, path)),
);
assertPublicGuideReleaseSource(readFileSync(join(root, "src/community-guide-release.ts"), "utf8"));
if (existsSync(join(destination, ".git")))
  throw Error(
    "Refusing to overwrite a Git repository; preserve it and remove the export directory explicitly first.",
  );
if (existsSync(destination) && !existsSync(marker))
  throw Error("Destination exists without exporter ownership marker.");
if (existsSync(marker)) rmSync(destination, { recursive: true });
mkdirSync(destination, { recursive: true });
writeFileSync(marker, "Curated public source snapshot; no private Git history.\n");
const write = (path, text) => {
  mkdirSync(dirname(join(destination, path)), { recursive: true });
  writeFileSync(join(destination, path), text);
};
const pathsBelow = (directory, prefix = "") =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory() ? pathsBelow(join(directory, entry.name), path) : [path];
  });
const copy = (path) => {
  mkdirSync(dirname(join(destination, path)), { recursive: true });
  cpSync(join(root, path), join(destination, path), { recursive: true });
};
for (const path of PUBLIC_COPY_PATHS) copy(path);
for (const path of PUBLIC_RUNTIME_MIGRATION_PATHS) copy(path);
for (const name of PUBLIC_QA_NAMES) copy(`qa/${name}`);
for (const name of PUBLIC_DOC_NAMES) copy("docs/" + name);
copy("README.md");
write(
  "docs/archive/README.md",
  "# 보관 문서\n\n과거 공개 문서는 Git 이력에서 확인할 수 있습니다. 현재 사용법은 [문서 안내](../README.md)를 따릅니다.\n",
);
write(
  "docs/research/README.md",
  "# 조사 자료\n\n공개 가능한 조사 자료를 별도로 관리합니다. 현재 결정은 [제품 원칙](../PRODUCT_PRINCIPLES.md), 앞으로의 계획은 [로드맵](../ROADMAP.md)을 따릅니다.\n",
);
let designJournal = readFileSync(join(root, "docs/research/DESIGN_JOURNAL.md"), "utf8");
for (const [link, label] of [
  ["COMMUNITY_BENCHMARK.md", "커뮤니티 벤치마크"],
  ["../archive/PROACTIVE_SUPPORT_DESIGN.md", "선제적 지원 조사"],
  ["TRUST_REWARDS_REVENUE.md", "지인 신뢰와 수익 조사"],
])
  designJournal = designJournal.replaceAll(`[${label}](${link})`, label);
write("docs/research/DESIGN_JOURNAL.md", designJournal);
for (const name of readdirSync(join(root, "qa")).filter((name) =>
  /^(community-weekend[^/]*|weekends)\.mjs$/.test(name),
))
  copy(`qa/${name}`);
write(".gitignore", readFileSync(join(root, ".gitignore"), "utf8") + "\n.public-export\n");
const config = sanitizeWranglerConfig(
  JSON.parse(readFileSync(join(root, "wrangler.jsonc"), "utf8")),
);
assertSanitizedCoreConfig(config);
write("wrangler.jsonc", JSON.stringify(config, null, 2) + "\n");
const siteConfig = sanitizeSiteWranglerConfig(
  JSON.parse(readFileSync(join(root, "site/wrangler.jsonc"), "utf8")),
);
write("site/wrangler.jsonc", JSON.stringify(siteConfig, null, 2) + "\n");
const siteQaCoreConfig = sanitizeSiteQaCoreConfig(
  JSON.parse(readFileSync(join(root, "site/qa/fake-core.wrangler.jsonc"), "utf8")),
);
write("site/qa/fake-core.wrangler.jsonc", JSON.stringify(siteQaCoreConfig, null, 2) + "\n");
const packageMetadata = sanitizePackageMetadata(
  JSON.parse(readFileSync(join(root, "package.json"), "utf8")),
);
write("package.json", JSON.stringify(packageMetadata, null, 2) + "\n");
write(
  "scripts/test-unit.mjs",
  readFileSync(join(root, "scripts/test-unit.mjs"), "utf8").replace(
    '  "community-guide-export",\n',
    "",
  ),
);
assertPublicExportPaths(pathsBelow(destination));
execFileSync("bun", ["install"], { cwd: destination, stdio: "pipe" });

write(
  "slack-manifest.json",
  execFileSync(
    process.execPath,
    [join(root, "scripts/slack-manifest.mjs"), "https://your-worker.workers.dev"],
    { encoding: "utf8" },
  ),
);
let migration = readFileSync(join(root, "migrations/006_normalized_foundation.sql"), "utf8");
function replaceBetween(start, end, replacement) {
  const a = migration.indexOf(start),
    b = migration.indexOf(end, a);
  if (a < 0 || b < a) throw Error("Migration source changed; inspect export transformation.");
  migration = migration.slice(0, a) + replacement + migration.slice(b);
}
if (migration.includes("-- Explicit production mapping")) {
  replaceBetween(
    "-- Explicit production mapping",
    "DO $$ BEGIN\n IF EXISTS(SELECT 1 FROM otl.goals",
    `-- Fresh installs contain no goals. Existing installations must supply an explicitly\n-- reviewed workspace/channel mapping here before importing legacy goals.\n`,
  );
  replaceBetween(" CASE WHEN d.user_id=", " FROM otl.community_days d JOIN", " NULL::text\n");
  replaceBetween(
    "DO $$ BEGIN\n IF EXISTS(SELECT 1 FROM otl_archive.goal_reconciliation",
    "ALTER TABLE otl.community_days ADD COLUMN",
    `DO $$ BEGIN\n IF EXISTS(SELECT 1 FROM otl_archive.goal_reconciliation WHERE legacy_before IS NOT NULL)\n THEN RAISE EXCEPTION 'Unreviewed source disagreement; reconcile explicitly before migration'; END IF;\nEND $$;\n\n`,
  );
} else if (!migration.includes("-- Fresh installs contain no goals")) {
  throw Error("Migration source changed; inspect export transformation.");
}
write("migrations/006_normalized_foundation.sql", migration);
write(".dev.vars", readFileSync(join(root, ".dev.vars.example"), "utf8"));
try {
  execFileSync(
    join(destination, "node_modules/.bin/wrangler"),
    ["types", "worker-configuration.d.ts", "--env-interface", "CloudflareBindings"],
    { cwd: destination, stdio: "pipe" },
  );
} finally {
  rmSync(join(destination, ".dev.vars"));
}
console.log("Public snapshot prepared at " + destination);
