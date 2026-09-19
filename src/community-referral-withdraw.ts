import { z } from "zod";
import type { ReferralRuntimeStore } from "./community-referral-types";

const withdrawalSchema = z
  .object({
    receiptId: z.string().regex(/^RCP-[A-Z0-9-]{4,64}$/),
    withdrawalToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    withdrawalKey: z.string().min(8).max(120),
  })
  .strict();

export async function handleReferralWithdrawal(
  decoded: unknown,
  teamId: string,
  store: ReferralRuntimeStore,
): Promise<Response> {
  const parsed = withdrawalSchema.safeParse(decoded);
  if (!parsed.success) return Response.json({ error: "unavailable" }, { status: 404 });
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(parsed.data.withdrawalToken),
  );
  const withdrawalDigest = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  const result = await store.withdraw({
    teamId,
    receiptId: parsed.data.receiptId,
    withdrawalDigest,
    key: parsed.data.withdrawalKey,
    now: new Date().toISOString(),
  });
  if (result.kind === "rejected") return Response.json({ error: "unavailable" }, { status: 404 });
  return Response.json({ receiptId: result.receiptId, state: result.state }, { status: 202 });
}
