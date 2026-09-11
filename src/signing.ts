const encoder = new TextEncoder();

async function key(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export async function sign(text: string, secret: string): Promise<string> {
  const bytes = new Uint8Array(
    await crypto.subtle.sign("HMAC", await key(secret), encoder.encode(text)),
  );
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function verify(text: string, signature: string, secret: string): Promise<boolean> {
  if (!/^[0-9a-f]{64}$/.test(signature)) return false;
  const bytes = Uint8Array.from(signature.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));
  return crypto.subtle.verify("HMAC", await key(secret), bytes, encoder.encode(text));
}

export async function verifySlack(
  request: Request,
  body: string,
  secret: string,
): Promise<number | null> {
  const rawTime = request.headers.get("x-slack-request-timestamp") ?? "";
  const signature = request.headers.get("x-slack-signature") ?? "";
  const timestamp = Number(rawTime);
  if (
    !/^\d+$/.test(rawTime) ||
    Math.abs(Date.now() / 1000 - timestamp) > 300 ||
    !signature.startsWith("v0=")
  )
    return null;
  return (await verify(`v0:${rawTime}:${body}`, signature.slice(3), secret)) ? timestamp : null;
}
