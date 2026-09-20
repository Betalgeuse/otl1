import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { WELCOME_GUIDE_RELEASE } from "../src/community-guide-release.ts";
const config=JSON.parse(readFileSync(new URL("../wrangler.jsonc",import.meta.url),"utf8"));
for (const key of ["COMMUNITY_GUIDE_SOURCE_TS","COMMUNITY_GUIDE_SOURCE_EDITED_TS","COMMUNITY_GUIDE_VERSION","COMMUNITY_GUIDE_FILE_IDS","COMMUNITY_GUIDE_CONTENT_HASH"])
 assert.equal(config.vars[key],undefined);
assert.equal(WELCOME_GUIDE_RELEASE.version,"v0.0.56");
assert.deepEqual(WELCOME_GUIDE_RELEASE.orderedFileIds,["F0C2S01GE06","F0C2P2G2DFF"]);
console.log("PASS welcome copy is repo-owned and Worker config contains no Slack source pins");
