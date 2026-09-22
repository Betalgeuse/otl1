import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const documents = [
  "README.md",
  "docs/README.md",
  "docs/PRODUCT_PRINCIPLES.md",
  "docs/ARCHITECTURE.md",
  "docs/OPERATIONS.md",
  "docs/USER_GUIDE.md",
  "docs/ROADMAP.md",
  "docs/UPDATE_HISTORY.md",
];

for (const document of documents) {
  const source = readFileSync(resolve(root, document), "utf8");
  for (const [, destination] of source.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
    if (/^(?:https?:|mailto:|#)/.test(destination)) continue;
    const path = destination.split("#", 1)[0];
    assert.ok(existsSync(resolve(root, dirname(document), path)), `${document} links to ${destination}`);
  }
}

console.log(`PASS ${documents.length} current product documents have resolvable local links`);
