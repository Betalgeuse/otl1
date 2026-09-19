type Env = { readonly SITE_CORE_HMAC_SECRET: string };
const receipts = new Map<string, { readonly receiptId: string; readonly withdrawalToken: string; withdrawn: boolean }>();
let resolveCalls = 0;
let applyCalls = 0;
let created = 0;
let withdrawals = 0;

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
    if (request.method === "GET" && url.pathname === "/__qa/stats") return Response.json({ resolveCalls, applyCalls, created, withdrawals, receipts: receipts.size });
    const body = await request.text();
    if (request.headers.get("x-otl-signature") !== await signature(env.SITE_CORE_HMAC_SECRET, request, body)) return new Response("Unauthorized", { status: 401 });
    const input = JSON.parse(body) as Record<string, string>;
    if (url.pathname === "/internal/referrals/resolve") {
      resolveCalls += 1;
      return Response.json({ available: input.referralToken === "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" });
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
