import assert from 'node:assert/strict';
import worker from '../src/index.ts';

const results = [];
let siteverify = { success: true, action: 'interest-submit', hostname: 'otl1.hyuk.me' };
let coreCalls = 0;
const env = {
  PUBLIC_INTEREST_ENABLED: 'true', TURNSTILE_SITE_KEY: 'production-site-key', TURNSTILE_SECRET: 'test-secret', SITE_CORE_HMAC_SECRET: 'test-hmac-secret',
  RATE_LIMITER: { limit: async () => ({ success: true }) },
  CORE: { fetch: async (request) => { coreCalls++; assert.equal(new URL(request.url).pathname, '/internal/interest/submit'); return Response.json({ receiptId: 'INT-TEST1234', withdrawalToken: 'A'.repeat(43) }, { status: 202 }); } },
  ASSETS: { fetch: async () => new Response('<form></form>') },
};
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  assert.equal(url, 'https://challenges.cloudflare.com/turnstile/v0/siteverify');
  return Response.json(siteverify);
};
try {
  for (const [scenario, result, status] of [
    ['expired', { success: false, 'error-codes': ['timeout-or-duplicate'] }, 422],
    ['wrong action', { success: true, action: 'invite-apply', hostname: 'otl1.hyuk.me' }, 422],
    ['wrong hostname', { success: true, action: 'interest-submit', hostname: 'attacker.example' }, 422],
    ['first use', { success: true, action: 'interest-submit', hostname: 'otl1.hyuk.me' }, 303],
    ['replayed', { success: false, 'error-codes': ['timeout-or-duplicate'] }, 422],
  ]) {
    siteverify = result;
    const before = coreCalls;
    const body = new URLSearchParams({ email: 'test@example.com', displayName: '테스트', intent: '함께 한 가지를 끝내고 싶습니다.', knownMemberClue: '', consent: 'interest-consent-v1', inviteConsent: 'invite-consent-v1', submissionKey: crypto.randomUUID(), 'cf-turnstile-response': 'opaque-token' });
    const response = await worker.fetch(new Request('https://otl1.hyuk.me/interest', { method: 'POST', body }), env);
    assert.equal(response.status, status, scenario);
    assert.equal(coreCalls - before, status === 303 ? 1 : 0, scenario);
    results.push({ scenario, status: response.status, coreCallsDelta: coreCalls - before });
  }
  siteverify = { success: true, action: 'interest-submit', hostname: 'otl1.hyuk.me' };
  const keys = [];
  const limitedEnv = { ...env, RATE_LIMITER: { limit: async ({ key }) => { keys.push(key); return { success: key !== 'interest:global' }; } } };
  const limitedBody = new URLSearchParams({ email: 'test@example.com', displayName: '테스트', intent: '함께 하고 싶습니다.', knownMemberClue: '', consent: 'interest-consent-v1', inviteConsent: 'invite-consent-v1', submissionKey: crypto.randomUUID(), 'cf-turnstile-response': 'opaque-token' });
  const limited = await worker.fetch(new Request('https://otl1.hyuk.me/interest', { method: 'POST', headers: { 'cf-connecting-ip': '192.0.2.1' }, body: limitedBody }), limitedEnv);
  assert.equal(limited.status, 429);
  assert.deepEqual(keys, ['interest:ip:192.0.2.1', 'interest:global']);
  assert.equal(coreCalls, 1);
  results.push({ scenario: 'per-IP and global rate keys', status: 429, keys, coreCallsDelta: 0 });
  const disabledEnv = { ...env, PUBLIC_INTEREST_ENABLED: 'false', ASSETS: { fetch: async () => new Response('<p>__INTEREST_COPY__</p>__INTEREST_CTA__') } };
  const disabledPage = await worker.fetch(new Request('https://otl1.hyuk.me/interest'), disabledEnv);
  assert.equal(disabledPage.status, 503);
  const disabledSubmit = await worker.fetch(new Request('https://otl1.hyuk.me/interest', { method: 'POST', body: limitedBody }), disabledEnv);
  assert.equal(disabledSubmit.status, 503);
  const disabledHome = await (await worker.fetch(new Request('https://otl1.hyuk.me/'), disabledEnv)).text();
  assert.match(disabledHome, /준비하고 있습니다/);
  assert.doesNotMatch(disabledHome, /href=\"\/interest\"/);
  results.push({ scenario: 'disabled flag hides form and CTA', getStatus: 503, postStatus: 503, linked: false });
  console.log(JSON.stringify({ ok: true, results }, null, 2));
} finally { globalThis.fetch = originalFetch; }
