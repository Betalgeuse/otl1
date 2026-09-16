import {
  bugDeliveryProviderSubcode,
  bugDeliveryRetryDelay,
  classifyBugDeliveryError,
} from "./community-bug-delivery-errors";
import {
  type BugDelivery,
  type BugDeliveryDestination,
  CommunityBugDeliveryStore,
  type EnqueueBugDelivery,
} from "./community-bug-delivery-store";
import {
  BUG_ENUM_QUESTIONS,
  BUG_FREE_QUESTIONS,
  type BugField,
  type BugQuestion,
  isBugField,
} from "./community-bug-schema";
import { bugQuestionPayload } from "./community-bug-slack";
import type { BugQuestionRead } from "./community-bug-types";
import { type CommunityContext, ephemeral, payloadRecord, post } from "./community-runtime";
import { CommunitySlackError, callSlack } from "./community-social";
import type { Json } from "./input";
import { string } from "./input";
import { NeonStore } from "./store";

export const BUG_DELIVERY_WORKER_ID = "slack-bug-delivery" as const;
const QUESTION_RENDERER = "bug-question.v1" as const;

type QuestionDelivery = {
  readonly bugId: string;
  readonly reporterId: string;
  readonly packetRevision: number;
  readonly questionId: string;
  readonly fieldName: BugField;
  readonly templateId: string;
  readonly question: BugQuestion;
};

function stores(context: CommunityContext) {
  const db = new NeonStore(context.env.DATABASE_URL);
  return new CommunityBugDeliveryStore(db);
}

export function bugDeliveryKey(
  bugId: string,
  packetRevision: number,
  kind: EnqueueBugDelivery["deliveryKind"],
  destination: BugDeliveryDestination,
): string {
  return `${bugId}:${packetRevision}:${kind}:${destination}`;
}

async function send(
  context: CommunityContext,
  destination: BugDeliveryDestination,
  message: Json,
): Promise<string> {
  if (destination === "reporter_thread") return post(context, message);
  if (destination === "reporter_ephemeral") return ephemeral(context, message);
  const channel = context.env.COMMUNITY_CHANNEL_ID;
  if (!channel) throw new CommunitySlackError("channel_not_found");
  const result = await callSlack(context.env.SLACK_BOT_TOKEN, "chat.postMessage", {
    ...payloadRecord(message),
    channel,
  });
  return string(result.ts);
}

export async function deliverBugMessage(
  context: CommunityContext,
  input: EnqueueBugDelivery,
  message: Json,
): Promise<void> {
  const deliveries = stores(context);
  await deliveries.enqueue(input);
  const leaseToken = crypto.randomUUID();
  const claimed = await deliveries.claim({
    teamId: input.teamId,
    bugId: input.bugId,
    reporterId: input.reporterId,
    deliveryKey: input.deliveryKey,
    workerId: BUG_DELIVERY_WORKER_ID,
    leaseToken,
  });
  if (!claimed) return;
  await sendClaimedBugDelivery(context, claimed, input.reporterId, leaseToken, message);
}

export async function sendClaimedBugDelivery(
  context: CommunityContext,
  claimed: BugDelivery,
  reporterId: string,
  leaseToken: string,
  message: Json,
): Promise<"sent" | "failed"> {
  const deliveries = stores(context);
  try {
    const messageTs = await send(context, claimed.destination, message);
    await deliveries.finish({
      teamId: claimed.teamId,
      bugId: claimed.bugId,
      reporterId,
      deliveryId: claimed.deliveryId,
      workerId: BUG_DELIVERY_WORKER_ID,
      leaseToken,
      status: "sent",
      messageTs,
    });
    return "sent";
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    const code = classifyBugDeliveryError(error);
    await deliveries.finish({
      teamId: claimed.teamId,
      bugId: claimed.bugId,
      reporterId,
      deliveryId: claimed.deliveryId,
      workerId: BUG_DELIVERY_WORKER_ID,
      leaseToken,
      status: "failed",
      errorCode: code,
      ...(claimed.attempts < 3
        ? { retryAfter: new Date(Date.now() + bugDeliveryRetryDelay(error)).toISOString() }
        : {}),
    });
    console.error(
      JSON.stringify({
        event: "community.bug.delivery.failed",
        bugId: claimed.bugId,
        deliveryId: claimed.deliveryId,
        code,
        providerSubcode: bugDeliveryProviderSubcode(error),
      }),
    );
    return "failed";
  }
}

export async function failClaimedBugDelivery(
  context: CommunityContext,
  claimed: BugDelivery,
  reporterId: string,
  leaseToken: string,
): Promise<"failed"> {
  await stores(context).finish({
    teamId: claimed.teamId,
    bugId: claimed.bugId,
    reporterId,
    deliveryId: claimed.deliveryId,
    workerId: BUG_DELIVERY_WORKER_ID,
    leaseToken,
    status: "failed",
    errorCode: "invalid_payload",
    ...(claimed.attempts < 3 ? { retryAfter: new Date(Date.now() + 60_000).toISOString() } : {}),
  });
  return "failed";
}

export function bugQuestionForField(field: BugField): BugQuestion {
  if (field === "frequency" || field === "impact")
    return { field, kind: "single_select", ...BUG_ENUM_QUESTIONS[field] };
  return { field, kind: "free_text", text: BUG_FREE_QUESTIONS[field] };
}

export function questionDeliveryFromRead(
  bugId: string,
  reporterId: string,
  question: BugQuestionRead,
): QuestionDelivery | null {
  if (!isBugField(question.fieldName)) return null;
  return {
    bugId,
    reporterId,
    packetRevision: question.askedPacketRevision,
    questionId: question.questionId,
    fieldName: question.fieldName,
    templateId: question.templateVersion,
    question: bugQuestionForField(question.fieldName),
  };
}

export async function deliverBugQuestion(
  context: CommunityContext,
  input: QuestionDelivery,
): Promise<void> {
  const destination = "reporter_thread" as const;
  await deliverBugMessage(
    context,
    {
      teamId: context.scope.teamId,
      bugId: input.bugId,
      reporterId: input.reporterId,
      deliveryKey: bugDeliveryKey(input.bugId, input.packetRevision, "question", destination),
      packetRevision: input.packetRevision,
      deliveryKind: "question",
      destination,
      templateId: input.templateId,
      fieldName: input.fieldName,
      rendererVersion: QUESTION_RENDERER,
      questionId: input.questionId,
    },
    bugQuestionPayload(
      context,
      input.bugId,
      input.questionId,
      input.packetRevision,
      input.question,
    ),
  );
}

export function bugQuestionTemplate(field: BugField): string {
  return `question.${field}.v1`;
}
