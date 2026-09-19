import { CommunityInterestStore } from "./community-interest-store";
import type { CommunityEnv } from "./community-runtime";
import { sign, verify } from "./signing";
import { NeonStore } from "./store";

const shaBytes = async (bytes: BufferSource): Promise<string> =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
const sha = async (text: string): Promise<string> => shaBytes(new TextEncoder().encode(text));

type Marker = {
  readonly interestId: string;
  readonly submissionKeyDigest: string;
  readonly objectDigest: string;
  readonly opaqueRef: string;
  readonly createdAt: string;
  readonly status: "pending" | "dead";
};

function marker(value: unknown): Marker | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const row = Object.fromEntries(Object.entries(value));
  if (
    typeof row.interestId !== "string" ||
    !/^IREQ-[A-Z0-9-]{4,64}$/.test(row.interestId) ||
    typeof row.submissionKeyDigest !== "string" ||
    !/^[0-9a-f]{64}$/.test(row.submissionKeyDigest) ||
    typeof row.objectDigest !== "string" ||
    !/^[0-9a-f]{64}$/.test(row.objectDigest) ||
    typeof row.opaqueRef !== "string" ||
    !row.opaqueRef.startsWith(`interest-private/${row.interestId}/revision-0-`) ||
    typeof row.createdAt !== "string" ||
    !Number.isFinite(Date.parse(row.createdAt)) ||
    (row.status !== "pending" && row.status !== "dead")
  )
    return null;
  return {
    interestId: row.interestId,
    submissionKeyDigest: row.submissionKeyDigest,
    objectDigest: row.objectDigest,
    opaqueRef: row.opaqueRef,
    createdAt: row.createdAt,
    status: row.status,
  };
}

export async function reconcileInterestIntake(
  env: CommunityEnv,
  now = Date.now(),
  startCursor?: string,
): Promise<{
  readonly processed: number;
  readonly possiblyMore: boolean;
  readonly nextCursor: string | null;
}> {
  if (env.DATABASE_MAINTENANCE === "true")
    return { processed: 0, possiblyMore: false, nextCursor: null };
  if (
    !env.INVITE_PRIVATE_OBJECTS ||
    !env.INTEREST_RUNTIME_DATABASE_URL ||
    !env.SITE_CORE_HMAC_SECRET
  )
    throw new Error("Interest reconciliation unavailable");
  const store = new CommunityInterestStore(new NeonStore(env.INTEREST_RUNTIME_DATABASE_URL));
  const bucket = env.INVITE_PRIVATE_OBJECTS;
  const prefix = `interest-private-reconcile/v1/${await sha(env.SLACK_TEAM_ID)}/`;
  let processed = 0;
  let cursor: string | undefined = startCursor;
  for (let page = 0; page < 5; page += 1) {
    const list = await bucket.list({ prefix, limit: 50, ...(cursor ? { cursor } : {}) });
    for (const entry of list.objects) {
      if (processed >= 2) return { processed, possiblyMore: true, nextCursor: null };
      const stored = await bucket.get(entry.key);
      if (!stored) continue;
      let wrapper: unknown;
      try {
        wrapper = JSON.parse(new TextDecoder().decode(await stored.arrayBuffer()));
      } catch (error) {
        if (error instanceof SyntaxError) continue;
        throw error;
      }
      if (typeof wrapper !== "object" || wrapper === null || Array.isArray(wrapper)) continue;
      const signed = Object.fromEntries(Object.entries(wrapper));
      if (
        typeof signed.marker !== "string" ||
        typeof signed.signature !== "string" ||
        !(await verify(signed.marker, signed.signature, env.SITE_CORE_HMAC_SECRET))
      )
        continue;
      let decoded: unknown;
      try {
        decoded = JSON.parse(signed.marker);
      } catch (error) {
        if (error instanceof SyntaxError) continue;
        throw error;
      }
      const value = marker(decoded);
      if (!value || entry.key !== `${prefix}${value.interestId}.json` || value.status === "dead")
        continue;
      const deadLetter = async (): Promise<void> => {
        const dead = JSON.stringify({ ...value, status: "dead" });
        await bucket.put(
          entry.key,
          new TextEncoder().encode(
            JSON.stringify({
              marker: dead,
              signature: await sign(dead, env.SITE_CORE_HMAC_SECRET ?? ""),
            }),
          ).buffer,
          { onlyIf: { etagMatches: stored.etag } },
        );
        console.error(
          JSON.stringify({ event: "interest.reconcile.dead", interestId: value.interestId }),
        );
        processed += 1;
      };
      const state = await store.findPrivateIntake(
        env.SLACK_TEAM_ID,
        value.interestId,
        value.objectDigest,
      );
      if (state === "conflict") {
        await deadLetter();
      } else if (state === "adopted") {
        await bucket.delete(entry.key);
        processed += 1;
      } else if (state === "absent" && now >= Date.parse(value.createdAt) + 15 * 60_000) {
        const object = await bucket.get(value.opaqueRef);
        if (object && (await shaBytes(await object.arrayBuffer())) !== value.objectDigest) {
          await deadLetter();
          continue;
        }
        if (object) await bucket.delete(value.opaqueRef);
        await bucket.delete(entry.key);
        processed += 1;
      }
    }
    if (!list.truncated) return { processed, possiblyMore: false, nextCursor: null };
    if (!list.cursor) throw new Error("Interest reconciliation cursor unavailable");
    cursor = list.cursor;
  }
  return { processed, possiblyMore: true, nextCursor: cursor ?? null };
}
