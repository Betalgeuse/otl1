import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const temp = await mkdtemp(join(tmpdir(), "otl-release-http-"));
const processes = [];
const secret = "synthetic-local-hmac-only-1234567890";
const ports = [41200, 41201].map((base) => base + Math.floor(Math.random() * 1000));
const worker = join(root, "node_modules/.bin/wrangler");
function launch(args) {
  const child = spawn(worker, args, { cwd: root, env: { ...process.env, WRANGLER_SEND_METRICS: "false" }, stdio: "ignore" });
  processes.push(child);
  return child;
}
async function ready(url, child) {
  for (let attempt = 0; attempt < 80; attempt++) {
    assert.equal(child.exitCode, null, "local Worker exited before HTTP readiness");
    try { return await fetch(url, { signal: AbortSignal.timeout(1000) }); }
    catch { await new Promise((done) => setTimeout(done, 250)); }
  }
  throw new Error("local Worker HTTP readiness timed out");
}
try {
  const common = ["--local", "--ip", "127.0.0.1", "--show-interactive-dev-session", "false", "--log-level", "error", "--var", `SITE_CORE_HMAC_SECRET:${secret}`];
  const core = launch(["dev", "-c", "site/qa/fake-core.wrangler.jsonc", "--port", String(ports[0]), "--persist-to", join(temp, "core"), ...common]);
  const coreUrl = `http://127.0.0.1:${ports[0]}`;
  assert.equal((await ready(`${coreUrl}/__qa/stats`, core)).status, 200);
  const site = launch(["dev", "-c", "site/wrangler.jsonc", "--port", String(ports[1]), "--persist-to", join(temp, "site"), ...common]);
  const siteUrl = `http://127.0.0.1:${ports[1]}`;
  const home = await ready(siteUrl, site);
  assert.equal(home.status, 200);
  assert.ok(home.headers.get("content-security-policy"));
  const homeText = await home.text();
  assert.match(homeText, /참여 문의 준비 중/);
  const interest = await fetch(`${siteUrl}/interest`, { signal: AbortSignal.timeout(5000) });
  assert.equal(interest.status, 503);
  const interestSubmit = await fetch(`${siteUrl}/interest`, { method: "POST", body: new FormData(), signal: AbortSignal.timeout(5000) });
  assert.equal(interestSubmit.status, 503);
  const referral = await fetch(`${siteUrl}/r/${"A".repeat(32)}`, { signal: AbortSignal.timeout(5000) });
  assert.equal(referral.status, 200);
  const invalid = await fetch(`${siteUrl}/r/invalid`, { signal: AbortSignal.timeout(5000) });
  assert.equal(invalid.status, 404);
  const stats = await (await fetch(`${coreUrl}/__qa/stats`, { signal: AbortSignal.timeout(5000) })).json();
  assert.ok(stats.resolveCalls >= 1, "site did not reach CORE service binding");
  console.log(JSON.stringify({ status: "passed", http: [home.status, interest.status, interestSubmit.status, referral.status, invalid.status], coreResolveCalls: stats.resolveCalls }));
} finally {
  for (const child of processes) child.kill("SIGTERM");
  await Promise.all(processes.map((child) => new Promise((done) => child.exitCode === null ? child.once("exit", done) : done())));
  await rm(temp, { recursive: true, force: true });
}
