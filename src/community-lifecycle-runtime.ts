import {
  deliverLifecycleNotices,
  type LifecycleDeliveryResult,
} from "./community-lifecycle-delivery";
import { parseLifecycleMode } from "./community-lifecycle-evaluator";
import type { CommunityLifecycleRuntimeStore } from "./community-lifecycle-runtime-store";
import type { LifecycleBatchResult } from "./community-lifecycle-runtime-types";

const EMPTY_BATCH: LifecycleBatchResult = {
  processed: 0,
  candidates: 0,
  transitions: 0,
  possiblyMore: false,
  nextDue: null,
};
const EMPTY_DELIVERY: LifecycleDeliveryResult = {
  claimed: 0,
  sent: 0,
  failed: 0,
  dead: 0,
  possiblyMore: false,
  errorCodes: {},
};

export type LifecycleMaintenanceResult = {
  readonly evaluation: LifecycleBatchResult;
  readonly reconciliation: LifecycleBatchResult;
  readonly delivery: LifecycleDeliveryResult;
  readonly possiblyMore: boolean;
};

export async function runLifecycleMaintenance(input: {
  readonly store: CommunityLifecycleRuntimeStore;
  readonly teamId: string;
  readonly channelId: string;
  readonly token: string;
  readonly signingSecret: string;
  readonly mode: string | undefined;
  readonly maintenance: boolean;
  readonly serviceHealthComplete: boolean;
  readonly serviceDate: string;
  readonly now: number;
}): Promise<LifecycleMaintenanceResult> {
  const mode = parseLifecycleMode(input.mode);
  if (input.maintenance || !input.serviceHealthComplete || mode === "disabled")
    return {
      evaluation: EMPTY_BATCH,
      reconciliation: EMPTY_BATCH,
      delivery: EMPTY_DELIVERY,
      possiblyMore: false,
    };
  const evaluation = await input.store.evaluateBatch({
    teamId: input.teamId,
    channelId: input.channelId,
    date: input.serviceDate,
    now: new Date(input.now).toISOString(),
    mode,
    limit: 10,
  });
  if (mode === "shadow")
    return {
      evaluation,
      reconciliation: EMPTY_BATCH,
      delivery: EMPTY_DELIVERY,
      possiblyMore: evaluation.possiblyMore,
    };
  const reconciliation = await input.store.reconcile({
    teamId: input.teamId,
    now: new Date(input.now).toISOString(),
    limit: 10,
  });
  const delivery = await deliverLifecycleNotices({
    store: input.store,
    teamId: input.teamId,
    token: input.token,
    signingSecret: input.signingSecret,
    now: input.now,
  });
  return {
    evaluation,
    reconciliation,
    delivery,
    possiblyMore: evaluation.possiblyMore || reconciliation.possiblyMore || delivery.possiblyMore,
  };
}
