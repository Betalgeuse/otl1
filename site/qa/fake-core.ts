type Env = { readonly SITE_CORE_HMAC_SECRET: string };
const receipts = new Map<string, { readonly receiptId: string; readonly withdrawalToken: string; withdrawn: boolean }>();
let resolveCalls = 0;
let applyCalls = 0;
let directJoinCalls = 0;
let created = 0;
let withdrawals = 0;
const interestReceipts = new Map<string, { readonly receiptId: string; readonly withdrawalToken: string; readonly requestHash: string; withdrawn: boolean }>();
const interestEmails = new Set<string>();
const usedNonces = new Set<string>();
let interestCreated = 0;
let interestWithdrawals = 0;

function hex(value: ArrayBuffer): string { return Array.from(new Uint8Array(value), (byte) => byte.toString(16).padStart(2, "0")).join(""); }
async function sha256(value: string): Promise<string> { return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))); }
async function signature(secret: string, request: Request, body: string): Promise<string> {
  const timestamp = request.headers.get("x-otl-timestamp") ?? "";
  const nonce = request.headers.get("x-otl-nonce") ?? "";
  const canonical = [request.method, new URL(request.url).pathname, await sha256(body), timestamp, nonce].join("\n");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(canonical)));
}
function opaque(prefix: string): string { return `${prefix}-${crypto.randomUUID().replaceAll("-", "").toUpperCase()}`; }
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/__qa/stats") return Response.json({ resolveCalls, applyCalls, directJoinCalls, created, withdrawals, receipts: receipts.size, interestCreated, interestWithdrawals, interestReceipts: interestReceipts.size });
    const body = await request.text();
    if (request.headers.get("x-otl-signature") !== await signature(env.SITE_CORE_HMAC_SECRET, request, body)) return new Response("Unauthorized", { status: 401 });
    if (url.pathname.startsWith("/internal/interest/")) {
      const timestamp = Number(request.headers.get("x-otl-timestamp"));
      const nonce = request.headers.get("x-otl-nonce") ?? "";
      if (!Number.isSafeInteger(timestamp) || Math.abs(Date.now() / 1000 - timestamp) > 300 || !/^[A-Za-z0-9_-]{24}$/.test(nonce) || usedNonces.has(nonce)) return new Response("Unauthorized", { status: 401 });
      usedNonces.add(nonce);
    }
    const input = JSON.parse(body) as Record<string, string>;
    if (url.pathname === "/internal/interest/submit") {
      if (input.consentVersion !== "interest-consent-v1" || input.inviteConsentAccepted !== true || typeof input.inviteConsentedAt !== "string" || typeof input.email !== "string" || typeof input.displayName !== "string" || typeof input.intent !== "string" || typeof input.knownMemberClue !== "string" || typeof input.submissionKey !== "string" || typeof input.shareNameEmailWithIntroducer !== "boolean") return new Response("Bad request", { status: 400 });
      const requestHash = await sha256(JSON.stringify([input.email, input.displayName, input.intent, input.knownMemberClue, input.consentVersion, input.inviteConsentAccepted, input.shareNameEmailWithIntroducer]));
      const existing = interestReceipts.get(input.submissionKey);
      if (existing) return existing.requestHash === requestHash ? Response.json({ receiptId: existing.receiptId, withdrawalToken: existing.withdrawalToken }, { status: 202 }) : new Response("Conflict", { status: 409 });
      if (interestEmails.has(input.email.toLowerCase())) return Response.json({ receiptId: opaque("INT") }, { status: 202 });
      const item = { receiptId: opaque("INT"), withdrawalToken: crypto.randomUUID().replaceAll("-", "") + "ABCDEFGHIJK", requestHash, withdrawn: false };
      interestReceipts.set(input.submissionKey, item); interestEmails.add(input.email.toLowerCase()); interestCreated += 1;
      if (input.submissionKey.startsWith("qa-lost-response-")) return new Response("Response lost after commit", { status: 503 });
      return Response.json({ receiptId: item.receiptId, withdrawalToken: item.withdrawalToken }, { status: 202 });
    }
    if (url.pathname === "/internal/interest/withdraw") {
      const item = [...interestReceipts.values()].find((candidate) => candidate.receiptId === input.receiptId && candidate.withdrawalToken === input.withdrawalToken);
      if (item && !item.withdrawn) { item.withdrawn = true; interestWithdrawals += 1; }
      return Response.json({ receiptId: input.receiptId }, { status: 202 });
    }
    if (url.pathname === "/internal/referrals/resolve") {
      resolveCalls += 1;
      return Response.json({ available: input.referralToken === "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" });
    }
    if (url.pathname === "/internal/referrals/direct-join") {
      directJoinCalls += 1;
      if (input.consentVersion !== "invite-consent-v1" || typeof input.email !== "string" || typeof input.submissionKey !== "string" || typeof input.referralToken !== "string") return new Response("Bad request", { status: 400 });
      return Response.json({ accepted: true }, { status: 202 });
    }
    if (url.pathname === "/internal/referrals/apply") {
      applyCalls += 1;
      const existing = receipts.get(input.submissionKey ?? "");
      if (existing) return Response.json({ receiptId: existing.receiptId }, { status: 202 });
      const item = { receiptId: opaque("RCP"), withdrawalToken: crypto.randomUUID().replaceAll("-", "") + "ABCDEFGHIJK", withdrawn: false };
      receipts.set(input.submissionKey ?? "", item); created += 1;
      return Response.json({ receiptId: item.receiptId, withdrawalToken: item.withdrawalToken }, { status: 202 });
    }
    if (url.pathname === "/internal/referrals/withdraw") {
      const item = [...receipts.values()].find((candidate) => candidate.receiptId === input.receiptId && candidate.withdrawalToken === input.withdrawalToken);
      if (!item || item.withdrawn) return Response.json({ error: "unavailable" }, { status: 404 });
      item.withdrawn = true; withdrawals += 1;
      return Response.json({ receiptId: item.receiptId, state: "withdrawn" }, { status: 202 });
    }
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
