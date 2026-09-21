import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const config = JSON.parse(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"));
assert.deepEqual(config.placement, { region: "aws:ap-southeast-1" });
console.log("PASS Core placement stays close to the production Neon region");
