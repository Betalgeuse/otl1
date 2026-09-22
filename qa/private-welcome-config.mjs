import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { WELCOME_GUIDE_RELEASE } from "../src/community-guide-release.ts";
const config=JSON.parse(readFileSync(new URL("../wrangler.jsonc",import.meta.url),"utf8"));
for (const key of ["COMMUNITY_GUIDE_SOURCE_TS","COMMUNITY_GUIDE_SOURCE_EDITED_TS","COMMUNITY_GUIDE_VERSION","COMMUNITY_GUIDE_CONTENT_HASH"])
 assert.equal(config.vars[key],undefined);
assert.equal(WELCOME_GUIDE_RELEASE.version,"v0.0.57");
assert.equal(config.vars.COMMUNITY_GUIDE_FILE_IDS,"F0C2S01GE06,F0C2P2G2DFF");
assert.equal(WELCOME_GUIDE_RELEASE.body.includes("onething1line.slack.com"),false);
assert.match(WELCOME_GUIDE_RELEASE.body,/본인에게 편한 시간/);
assert.match(WELCOME_GUIDE_RELEASE.body,/다른 일이 더 쉬워지거나 필요 없어지는/);
assert.match(WELCOME_GUIDE_RELEASE.body,/오늘 안에 끝낼 만큼 작고, 완료 여부가 분명/);
console.log("PASS welcome copy is repo-owned and Worker config contains no Slack source pins");
