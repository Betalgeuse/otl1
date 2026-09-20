interface SiteEnv {
  readonly ASSETS: Fetcher;
  readonly CORE: Fetcher;
  readonly RATE_LIMITER: RateLimit;
  readonly TURNSTILE_SITE_KEY: string;
  readonly TURNSTILE_SECRET?: string;
  readonly SITE_CORE_HMAC_SECRET?: string;
  readonly PUBLIC_INTEREST_ENABLED?: string;
}

type TurnstileResult = { readonly success?: boolean; readonly action?: string; readonly hostname?: string };
const APPLY_PATH = "/internal/referrals/apply";
const WITHDRAW_PATH = "/internal/referrals/withdraw";
const RESOLVE_PATH = "/internal/referrals/resolve";
const INTEREST_SUBMIT_PATH = "/internal/interest/submit";
const INTEREST_WITHDRAW_PATH = "/internal/interest/withdraw";
const REFERRAL = /^\/r\/([A-Za-z0-9_-]{32})$/;
const APPLY = /^\/r\/([A-Za-z0-9_-]{32})\/apply$/;
const RECEIPT = /^\/receipt\/(RCP-[A-Z0-9-]{4,64})$/;
const WITHDRAW = /^\/receipt\/(RCP-[A-Z0-9-]{4,64})\/withdraw$/;
const INTEREST_RECEIPT = /^\/receipt\/(INT-[A-Z0-9-]{4,64})$/;
const INTEREST_WITHDRAW = /^\/receipt\/(INT-[A-Z0-9-]{4,64})\/withdraw$/;
const GENERIC_ERROR = "요청을 지금 처리할 수 없어요. 잠시 뒤 새로 확인해 주세요.";

export const SHARE_COPY = (token: string): string =>
  `매일 제일 중요한 일 하나 정해서 같이 끝내는 모임이야. 같이 할래?\nhttps://otl1.hyuk.me/r/${token}`;

const securityHeaders = {
  "Content-Security-Policy": "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self' https://challenges.cloudflare.com; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-src https://challenges.cloudflare.com; connect-src 'self' https://challenges.cloudflare.com; upgrade-insecure-requests",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
  "Referrer-Policy": "strict-origin",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
} as const;

function secured(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(securityHeaders)) headers.set(name, value);
  if ((headers.get("content-type") ?? "").includes("text/html")) headers.set("Cache-Control", "no-store");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function hex(value: ArrayBuffer): string {
  return Array.from(new Uint8Array(value), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
async function sha256(value: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}
export async function createSiteCoreSignature(method: string, path: string, body: string, timestamp: number, nonce: string): Promise<(secret: string) => Promise<string>> {
  const canonical = [method.toUpperCase(), path, await sha256(body), String(timestamp), nonce].join("\n");
  return async (secret: string) => {
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    return hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(canonical)));
  };
}

function base64Url(value: Uint8Array): string {
  return btoa(String.fromCharCode(...value)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
function randomToken(bytes: number): string { return base64Url(crypto.getRandomValues(new Uint8Array(bytes))); }
function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const decoded = atob(value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - value.length % 4) % 4));
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}

async function coreRequest(env: SiteEnv, path: string, payload: object): Promise<Response> {
  if (!env.SITE_CORE_HMAC_SECRET) throw new Error("site core signing unavailable");
  const body = JSON.stringify(payload);
  const timestamp = Math.floor(Date.now() / 1000);
  const nonce = randomToken(18);
  const sign = await createSiteCoreSignature("POST", path, body, timestamp, nonce);
  return env.CORE.fetch(new Request(`https://core.invalid${path}`, { method: "POST", headers: { "content-type": "application/json", "x-otl-timestamp": String(timestamp), "x-otl-nonce": nonce, "x-otl-signature": await sign(env.SITE_CORE_HMAC_SECRET) }, body }));
}

async function cookieKey(secret: string): Promise<CryptoKey> {
  const material = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`withdraw-cookie-v1\n${secret}`));
  return crypto.subtle.importKey("raw", material, "AES-GCM", false, ["encrypt", "decrypt"]);
}
export async function sealCapability(secret: string, receiptId: string, token: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(receiptId) }, await cookieKey(secret), new TextEncoder().encode(`${Date.now()}\n${token}`));
  return `${base64Url(iv)}.${base64Url(new Uint8Array(ciphertext))}`;
}
export async function openCapability(secret: string, receiptId: string, sealed: string): Promise<string | null> {
  try {
    const [ivValue, bodyValue] = sealed.split(".");
    if (!ivValue || !bodyValue) return null;
    const clear = await crypto.subtle.decrypt({ name: "AES-GCM", iv: decodeBase64Url(ivValue), additionalData: new TextEncoder().encode(receiptId) }, await cookieKey(secret), decodeBase64Url(bodyValue));
    const [issuedValue, token] = new TextDecoder().decode(clear).split("\n");
    const issuedAt = Number(issuedValue);
    return /^\d{13}$/.test(issuedValue ?? "") && Number.isSafeInteger(issuedAt) && issuedAt <= Date.now() && Date.now() - issuedAt <= 30 * 24 * 60 * 60 * 1000 && /^[A-Za-z0-9_-]{43}$/.test(token ?? "") ? token : null;
  } catch (error) { if (error instanceof Error) return null; throw error; }
}

function safeText(value: FormDataEntryValue | null, max: number): string | null {
  if (typeof value !== "string" || /[\u0000-\u001F\u007F\uFFFD]|[\uD800-\uDFFF]/u.test(value)) return null;
  const normalized = value.trim().normalize("NFC");
  return normalized && Array.from(normalized).length <= max ? normalized : null;
}
async function boundedForm(request: Request): Promise<FormData | null> {
  const reader = request.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    total += part.value.byteLength;
    if (total > 16_384) {
      await reader.cancel();
      return null;
    }
    chunks.push(part.value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new Request(request.url, {
    method: "POST",
    headers: { "content-type": request.headers.get("content-type") ?? "" },
    body,
  }).formData();
}
async function verifyTurnstile(request: Request, env: SiteEnv, token: string, action = "invite-apply"): Promise<"valid" | "invalid" | "unavailable"> {
  if (!env.TURNSTILE_SECRET || !token || token.length > 2048) return "invalid";
  try {
    const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, signal: AbortSignal.timeout(8_000), body: new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: token, remoteip: request.headers.get("cf-connecting-ip") ?? "" }) });
    if (!response.ok) return "unavailable";
    const result = await response.json<TurnstileResult>();
    const testKey = env.TURNSTILE_SITE_KEY === "1x00000000000000000000AA";
    const metadataValid = testKey
      ? result.action === undefined && result.hostname === "example.com"
      : result.action === action && result.hostname === new URL(request.url).hostname;
    if (result.success !== true || !metadataValid)
      console.warn(JSON.stringify({ event: "turnstile_rejected", success: result.success === true, metadataValid, testKey }));
    return result.success === true && metadataValid ? "valid" : "invalid";
  } catch (error) { if (error instanceof Error) return "unavailable"; throw error; }
}

async function assetHtml(env: SiteEnv, request: Request, name: string): Promise<string> {
  return (await env.ASSETS.fetch(new Request(new URL(`/${name}`, request.url)))).text();
}
function message(messageText: string, status: number): Response {
  return new Response(`<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/styles.css"><body class="status-page"><main><p class="eyebrow">ONE THING</p><h1>${messageText}</h1><a href="/">처음으로</a></main></body></html>`, { status, headers: { "content-type": "text/html;charset=UTF-8" } });
}
async function referralPage(request: Request, env: SiteEnv, token: string): Promise<Response> {
  const lookupKey = request.headers.get("cf-connecting-ip") ?? token;
  if (!(await env.RATE_LIMITER.limit({ key: `lookup:${lookupKey}` })).success) return message(GENERIC_ERROR, 429);
  const resolved = await availableLink(env, token);
  if (!resolved.available) return message(GENERIC_ERROR, 404);
  const html = await assetHtml(env, request, "referral.html");
  const headline = resolved.inviterName
    ? `${escapeHtml(resolved.inviterName)} 님이 같이 성장하자고<br>초대했어요!`
    : "같이 성장하자고<br>초대받았어요!";
  return new Response(html.replaceAll("__REFERRAL_TOKEN__", token).replaceAll("__TURNSTILE_SITE_KEY__", env.TURNSTILE_SITE_KEY).replaceAll("__SHARE_TEXT__", SHARE_COPY(token)).replaceAll("__SUBMISSION_KEY__", crypto.randomUUID()).replaceAll("__INVITER_HEADLINE__", headline), { headers: { "content-type": "text/html;charset=UTF-8" } });
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

async function availableLink(env: SiteEnv, token: string): Promise<{ readonly available: boolean; readonly inviterName: string | null }> {
  try {
    const response = await coreRequest(env, RESOLVE_PATH, { referralToken: token });
    if (!response.ok) return { available: false, inviterName: null };
    const result: unknown = await response.json();
    if (typeof result !== "object" || result === null || !("available" in result) || result.available !== true)
      return { available: false, inviterName: null };
    const inviterName = "inviterName" in result && typeof result.inviterName === "string" && [...result.inviterName].length <= 40 && result.inviterName.trim() && !Array.from(result.inviterName).some((character) => character.charCodeAt(0) < 32)
      ? result.inviterName : null;
    return { available: true, inviterName };
  } catch (error) { if (error instanceof Error) return { available: false, inviterName: null }; throw error; }
}

async function apply(request: Request, env: SiteEnv, token: string): Promise<Response> {
  const applicantIp = request.headers.get("cf-connecting-ip") ?? "unknown";
  if (!(await env.RATE_LIMITER.limit({ key: `apply:${applicantIp}` })).success) return message(GENERIC_ERROR, 429);
  if (!(await availableLink(env, token)).available) return message(GENERIC_ERROR, 404);
  if (Number(request.headers.get("content-length") ?? "0") > 16_384) return message(GENERIC_ERROR, 422);
  let form: FormData;
  try {
    const parsed = await boundedForm(request);
    if (!parsed) return message(GENERIC_ERROR, 422);
    form = parsed;
  } catch (error) { if (error instanceof Error) return message(GENERIC_ERROR, 422); throw error; }
  const email = safeText(form.get("email"), 320)?.toLowerCase() ?? null;
  const displayName = safeText(form.get("displayName"), 80);
  const intent = safeText(form.get("intent"), 1000);
  const submissionKey = safeText(form.get("submissionKey"), 120);
  const fieldsValid = Boolean(email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && displayName && intent && submissionKey && submissionKey.length >= 8 && form.get("consent") === "invite-consent-v1");
  if (!fieldsValid) {
    console.warn(JSON.stringify({ event: "invite_fields_rejected", email: Boolean(email), displayName: Boolean(displayName), intent: Boolean(intent), submissionKey: Boolean(submissionKey), consent: form.get("consent") === "invite-consent-v1" }));
    return message(GENERIC_ERROR, 422);
  }
  const turnstile = await verifyTurnstile(request, env, String(form.get("cf-turnstile-response") ?? ""));
  if (turnstile !== "valid") return message(GENERIC_ERROR, turnstile === "invalid" ? 422 : 503);
  try {
    const response = await coreRequest(env, APPLY_PATH, { referralToken: token, submissionKey, consentVersion: "invite-consent-v1", consentedAt: new Date().toISOString(), email, displayName, intent });
    if (response.status !== 202) return message(GENERIC_ERROR, 503);
    const result = await response.json<{ receiptId?: string; withdrawalToken?: string }>();
    if (!result.receiptId || !/^RCP-[A-Z0-9-]{4,64}$/.test(result.receiptId)) return message(GENERIC_ERROR, 503);
    const headers = new Headers({ location: `/receipt/${result.receiptId}` });
    if (result.withdrawalToken && env.SITE_CORE_HMAC_SECRET) {
      const sealed = await sealCapability(env.SITE_CORE_HMAC_SECRET, result.receiptId, result.withdrawalToken);
      headers.append("set-cookie", `otl1_withdraw=${sealed}; Path=/receipt/${result.receiptId}; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000`);
    }
    return new Response(null, { status: 303, headers });
  } catch (error) { if (error instanceof Error) return message(GENERIC_ERROR, 503); throw error; }
}

function interestEnabled(env: SiteEnv): boolean {
  return env.PUBLIC_INTEREST_ENABLED === "true" && Boolean(env.SITE_CORE_HMAC_SECRET && env.TURNSTILE_SECRET && env.TURNSTILE_SITE_KEY);
}

async function interestPage(request: Request, env: SiteEnv): Promise<Response> {
  if (!interestEnabled(env)) return message("참여 문의는 아직 준비 중입니다.", 503);
  const html = await assetHtml(env, request, "interest.html");
  return new Response(html.replaceAll("__TURNSTILE_SITE_KEY__", env.TURNSTILE_SITE_KEY).replaceAll("__SUBMISSION_KEY__", crypto.randomUUID()), { headers: { "content-type": "text/html;charset=UTF-8" } });
}

async function submitInterest(request: Request, env: SiteEnv): Promise<Response> {
  if (!interestEnabled(env)) return message("참여 문의는 아직 준비 중입니다.", 503);
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  if (!(await env.RATE_LIMITER.limit({ key: `interest:ip:${ip}` })).success || !(await env.RATE_LIMITER.limit({ key: "interest:global" })).success) return message(GENERIC_ERROR, 429);
  if (Number(request.headers.get("content-length") ?? "0") > 16_384) return message(GENERIC_ERROR, 422);
  let form: FormData;
  try {
    const parsed = await boundedForm(request);
    if (!parsed) return message(GENERIC_ERROR, 422);
    form = parsed;
  } catch (error) { if (error instanceof Error) return message(GENERIC_ERROR, 422); throw error; }
  const email = safeText(form.get("email"), 320)?.toLowerCase() ?? null;
  const displayName = safeText(form.get("displayName"), 80);
  const intent = safeText(form.get("intent"), 1000);
  const rawClue = form.get("knownMemberClue");
  const knownMemberClue = rawClue === "" || rawClue === null ? "" : safeText(rawClue, 200);
  const submissionKey = safeText(form.get("submissionKey"), 120);
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !displayName || !intent || knownMemberClue === null || !submissionKey || submissionKey.length < 8 || form.get("consent") !== "interest-consent-v1" || form.get("inviteConsent") !== "invite-consent-v1") return message(GENERIC_ERROR, 422);
  const shareNameEmailWithIntroducer = form.get("shareNameEmailWithIntroducer") === "yes";
  const turnstile = await verifyTurnstile(request, env, String(form.get("cf-turnstile-response") ?? ""), "interest-submit");
  if (turnstile !== "valid") return message(GENERIC_ERROR, turnstile === "invalid" ? 422 : 503);
  try {
    const consentedAt = new Date().toISOString();
    const response = await coreRequest(env, INTEREST_SUBMIT_PATH, { submissionKey, consentVersion: "interest-consent-v1", consentedAt, inviteConsentAccepted: true, inviteConsentedAt: consentedAt, email, displayName, intent, knownMemberClue, shareNameEmailWithIntroducer });
    if (response.status !== 202) return message(GENERIC_ERROR, 503);
    const result = await response.json<{ receiptId?: string; withdrawalToken?: string }>();
    if (!result.receiptId || !/^INT-[A-Z0-9-]{4,64}$/.test(result.receiptId) || (result.withdrawalToken && !/^[A-Za-z0-9_-]{43}$/.test(result.withdrawalToken))) return message(GENERIC_ERROR, 503);
    const headers = new Headers({ location: `/receipt/${result.receiptId}` });
    if (result.withdrawalToken && env.SITE_CORE_HMAC_SECRET) {
      const sealed = await sealCapability(env.SITE_CORE_HMAC_SECRET, result.receiptId, result.withdrawalToken);
      headers.set("set-cookie", `otl1_interest_withdraw=${sealed}; Path=/receipt/${result.receiptId}; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000`);
    }
    return new Response(null, { status: 303, headers });
  } catch (error) { if (error instanceof Error) return message(GENERIC_ERROR, 503); throw error; }
}

async function withdrawInterest(request: Request, env: SiteEnv, receiptId: string): Promise<Response> {
  if (!interestEnabled(env)) return message(GENERIC_ERROR, 503);
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  if (!(await env.RATE_LIMITER.limit({ key: `interest-withdraw:${ip}` })).success) return message(GENERIC_ERROR, 429);
  const sealed = request.headers.get("cookie")?.match(/(?:^|;\s*)otl1_interest_withdraw=([^;]+)/)?.[1];
  const token = sealed && env.SITE_CORE_HMAC_SECRET ? await openCapability(env.SITE_CORE_HMAC_SECRET, receiptId, sealed) : null;
  if (!token) return message(GENERIC_ERROR, 404);
  try {
    const form = await boundedForm(request);
    const withdrawalKey = form && safeText(form.get("withdrawalKey"), 120);
    if (!withdrawalKey || withdrawalKey.length < 8) return message(GENERIC_ERROR, 422);
    const response = await coreRequest(env, INTEREST_WITHDRAW_PATH, { receiptId, withdrawalToken: token, withdrawalKey });
    if (response.status !== 202) return message(GENERIC_ERROR, 503);
  } catch (error) { if (error instanceof Error) return message(GENERIC_ERROR, 503); throw error; }
  const confirmation = message("철회 요청을 확인했습니다.", 200);
  confirmation.headers.set("set-cookie", `otl1_interest_withdraw=; Path=/receipt/${receiptId}; HttpOnly; Secure; SameSite=Strict; Max-Age=0`);
  return confirmation;
}

async function withdraw(request: Request, env: SiteEnv, receiptId: string): Promise<Response> {
  if (!(await env.RATE_LIMITER.limit({ key: `withdraw:${receiptId}` })).success) return message(GENERIC_ERROR, 429);
  const sealed = request.headers.get("cookie")?.match(/(?:^|;\s*)otl1_withdraw=([^;]+)/)?.[1];
  if (!sealed || !env.SITE_CORE_HMAC_SECRET) return message(GENERIC_ERROR, 404);
  const token = await openCapability(env.SITE_CORE_HMAC_SECRET, receiptId, sealed);
  if (!token) return message(GENERIC_ERROR, 404);
  const form = await request.formData();
  const withdrawalKey = safeText(form.get("withdrawalKey"), 120);
  if (!withdrawalKey || withdrawalKey.length < 8) return message(GENERIC_ERROR, 404);
  try {
    const response = await coreRequest(env, WITHDRAW_PATH, { receiptId, withdrawalToken: token, withdrawalKey });
    if (response.status !== 202) return message(GENERIC_ERROR, 404);
    return new Response(null, { status: 303, headers: { location: `/receipt/${receiptId}?withdrawn=1`, "set-cookie": `otl1_withdraw=; Path=/receipt/${receiptId}; HttpOnly; Secure; SameSite=Strict; Max-Age=0` } });
  } catch (error) { if (error instanceof Error) return message(GENERIC_ERROR, 503); throw error; }
}

const siteWorker = {
  async fetch(request: Request, env: SiteEnv): Promise<Response> {
    const url = new URL(request.url);
    const referral = url.pathname.match(REFERRAL);
    const applyRoute = url.pathname.match(APPLY);
    const receipt = url.pathname.match(RECEIPT);
    const withdrawal = url.pathname.match(WITHDRAW);
    const interestReceipt = url.pathname.match(INTEREST_RECEIPT);
    const interestWithdrawal = url.pathname.match(INTEREST_WITHDRAW);
    let response: Response;
    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      const html = await assetHtml(env, request, "index.html");
      response = new Response(html.replace("__INTEREST_COPY__", interestEnabled(env) ? "소개 링크가 없다면 운영자에게 비공개 참여 문의를 남길 수 있습니다. 문의만으로 회원이 되거나 초대를 받지는 않습니다." : "소개 링크가 없는 분을 위한 비공개 참여 문의를 준비하고 있습니다. 문의만으로 회원이 되거나 초대를 받지는 않습니다.").replace("__INTEREST_CTA__", interestEnabled(env) ? '<a class="interest-pending" href="/interest">비공개 참여 문의 남기기</a>' : '<span class="interest-pending">참여 문의 준비 중</span>'), { headers: { "content-type": "text/html;charset=UTF-8" } });
    }
    else if (url.pathname === "/interest.html" || url.pathname === "/receipt.html") response = message(GENERIC_ERROR, 404);
    else if (request.method === "GET" && url.pathname === "/interest") response = await interestPage(request, env);
    else if (request.method === "POST" && url.pathname === "/interest") response = await submitInterest(request, env);
    else if (request.method === "GET" && referral) response = await referralPage(request, env, referral[1]);
    else if (request.method === "POST" && applyRoute) response = await apply(request, env, applyRoute[1]);
    else if (request.method === "GET" && interestReceipt) {
      const html = await assetHtml(env, request, "receipt.html");
      const sealed = request.headers.get("cookie")?.match(/(?:^|;\s*)otl1_interest_withdraw=([^;]+)/)?.[1];
      const capability = sealed && env.SITE_CORE_HMAC_SECRET ? await openCapability(env.SITE_CORE_HMAC_SECRET, interestReceipt[1], sealed) : null;
      const receiptBlock = capability ? `<p class="receipt-id"><span>영수증</span><strong>${interestReceipt[1]}</strong></p>` : "";
      const withdrawForm = capability ? `<form action="/receipt/${interestReceipt[1]}/withdraw" method="post"><input type="hidden" name="withdrawalKey" value="${crypto.randomUUID()}"><button class="button button--quiet" type="submit">문의 철회 요청</button></form>` : "";
      response = new Response(html.replaceAll("__RECEIPT_LABEL__", capability ? "문의 접수 기록" : "문의 확인").replaceAll("__STATUS__", capability ? "문의가 접수되었습니다." : "접수 여부를 확인할 수 없어요.").replaceAll("__RECEIPT_COPY__", capability ? "운영자가 문의를 검토합니다. 문의만으로 참여 자격이나 초대가 생기지 않으며, 참여하려면 기존 회원의 확인된 소개와 운영자 승인이 필요합니다." : "이 브라우저에서 문의 접수 기록을 확인할 수 없습니다. 이 화면은 문의 상태를 알려주지 않습니다.").replaceAll("__RECEIPT_BLOCK__", receiptBlock).replaceAll("__WITHDRAW_FORM__", withdrawForm), { headers: { "content-type": "text/html;charset=UTF-8" } });
    } else if (request.method === "POST" && interestWithdrawal) response = await withdrawInterest(request, env, interestWithdrawal[1]);
    else if (request.method === "GET" && receipt) {
      const html = await assetHtml(env, request, "receipt.html");
      const withdrawn = url.searchParams.get("withdrawn") === "1";
      const withdrawForm = withdrawn ? "" : `<form action="/receipt/${receipt[1]}/withdraw" method="post"><input type="hidden" name="withdrawalKey" value="${crypto.randomUUID()}"><button class="button button--quiet" type="submit">신청 철회</button></form>`;
      response = new Response(html.replaceAll("__RECEIPT_LABEL__", "신청 영수증").replaceAll("__RECEIPT_BLOCK__", `<p class="receipt-id"><span>영수증</span><strong>${receipt[1]}</strong></p>`).replaceAll("__RECEIPT_ID__", receipt[1]).replaceAll("__STATUS__", withdrawn ? "신청 철회가 접수되었습니다." : "신청이 안전하게 접수되었습니다.").replaceAll("__RECEIPT_COPY__", "운영자가 내용을 직접 확인합니다. 승인되면 Slack 초대를 수동으로 보내며, 초대를 수락해야 참여가 확인됩니다.").replaceAll("__WITHDRAW_FORM__", withdrawForm), { headers: { "content-type": "text/html;charset=UTF-8" } });
    } else if (request.method === "POST" && withdrawal) response = await withdraw(request, env, withdrawal[1]);
    else response = await env.ASSETS.fetch(request);
    return secured(response);
  },
} satisfies ExportedHandler<SiteEnv>;
export default siteWorker;
