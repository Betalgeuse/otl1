import { InputError, object, string } from "./input";
import type { NeonStore } from "./store";

const OPERATIONS = ["expire_due", "audit_retention", "nonce_retention"] as const;
type Operation = (typeof OPERATIONS)[number];

type Batch = {
  readonly processed: number;
  readonly possiblyMore: boolean;
  readonly nextDue: string | null;
};

function batch(value: unknown): Batch {
  const row = object(value);
  if (
    typeof row.processed !== "number" ||
    !Number.isSafeInteger(row.processed) ||
    typeof row.possiblyMore !== "boolean"
  )
    throw new InputError("Invalid retention batch");
  return {
    processed: row.processed,
    possiblyMore: row.possiblyMore,
    nextDue: row.nextDue === null ? null : string(row.nextDue),
  };
}

async function call(
  db: Pick<NeonStore, "queryJson">,
  teamId: string,
  now: number,
  operation: Operation | "next_due",
): Promise<Batch | { readonly nextDue: string | null }> {
  const result = object(
    await db.queryJson("SELECT otl.referral_retention_execute($1,$2::jsonb)", [
      operation,
      JSON.stringify({ teamId, now: new Date(now).toISOString(), limit: 10 }),
    ]),
  );
  if (operation === "next_due")
    return { nextDue: result.nextDue === null ? null : string(result.nextDue) };
  return batch(result);
}

export async function nextRetentionDue(
  db: Pick<NeonStore, "queryJson">,
  teamId: string,
  now: number,
): Promise<number | null> {
  const result = await call(db, teamId, now, "next_due");
  if (result.nextDue === null) return null;
  const due = Date.parse(result.nextDue);
  if (!Number.isFinite(due)) throw new InputError("Invalid retention due time");
  return due;
}

export async function runRetentionQueues(
  db: Pick<NeonStore, "queryJson">,
  teamId: string,
  now: number,
): Promise<{ readonly possiblyMore: boolean; readonly failed: boolean }> {
  let possiblyMore = false;
  let failed = false;
  for (const operation of OPERATIONS) {
    try {
      const result = await call(db, teamId, now, operation);
      if ("possiblyMore" in result) possiblyMore ||= result.possiblyMore;
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      failed = true;
      console.error(
        JSON.stringify({ event: "community.retention.failed", operation, errorType: error.name }),
      );
    }
  }
  return { possiblyMore, failed };
}
