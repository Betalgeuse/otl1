import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const config=JSON.parse(readFileSync(new URL("../wrangler.jsonc",import.meta.url),"utf8"));
assert.equal(config.vars.COMMUNITY_GUIDE_SOURCE_TS,"1789721925.521149");
assert.equal(config.vars.COMMUNITY_GUIDE_SOURCE_EDITED_TS,"1789722193.000000");
assert.equal(config.vars.COMMUNITY_GUIDE_VERSION,"v0.0.55");
assert.equal(config.vars.COMMUNITY_GUIDE_FILE_IDS,"F0C2S01GE06,F0C2P2G2DFF");
assert.equal(config.vars.COMMUNITY_GUIDE_CONTENT_HASH,"fbef79eaf1840ee8e6c68fa203c2fbde2bbdba70a598cd1dcd23379d55c44b85");
console.log("PASS private welcome source/version/assets are pinned in canonical order");
