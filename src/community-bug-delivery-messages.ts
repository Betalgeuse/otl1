import { bugDeliveryKey, deliverBugMessage } from "./community-bug-delivery";
import type { BugPacketFields } from "./community-bug-schema";
import { bugConfirmationPayload } from "./community-bug-slack";
import type { CommunityContext } from "./community-runtime";

const RENDERER_VERSION = "bug-message.v1" as const;

export async function deliverBugSummary(
  context: CommunityContext,
  input: {
    readonly bugId: string;
    readonly reporterId: string;
    readonly packetRevision: number;
    readonly revision: number;
    readonly label: string;
    readonly fields: BugPacketFields;
  },
): Promise<void> {
  const destination = "reporter_thread" as const;
  await deliverBugMessage(
    context,
    {
      teamId: context.scope.teamId,
      bugId: input.bugId,
      reporterId: input.reporterId,
      deliveryKey: bugDeliveryKey(input.bugId, input.packetRevision, "summary", destination),
      packetRevision: input.packetRevision,
      deliveryKind: "summary",
      destination,
      templateId: "summary.confirm.v1",
      rendererVersion: RENDERER_VERSION,
    },
    bugConfirmationPayload(context, input.label, input.bugId, input.revision, input.fields),
  );
}

export async function deliverBugReceipt(
  context: CommunityContext,
  input: { readonly bugId: string; readonly reporterId: string; readonly packetRevision: number },
): Promise<void> {
  const destination = "reporter_ephemeral" as const;
  await deliverBugMessage(
    context,
    {
      teamId: context.scope.teamId,
      bugId: input.bugId,
      reporterId: input.reporterId,
      deliveryKey: bugDeliveryKey(input.bugId, input.packetRevision, "receipt", destination),
      packetRevision: input.packetRevision,
      deliveryKind: "receipt",
      destination,
      templateId: "receipt.confirmed.v1",
      rendererVersion: RENDERER_VERSION,
    },
    { text: `접수됨 ${input.bugId}` },
  );
}

export async function deliverPrivateBugOutbox(
  context: CommunityContext,
  input: { readonly bugId: string; readonly reporterId: string; readonly packetRevision: number },
): Promise<void> {
  await Promise.all([
    deliverBugMessage(
      context,
      {
        teamId: context.scope.teamId,
        bugId: input.bugId,
        reporterId: input.reporterId,
        deliveryKey: bugDeliveryKey(
          input.bugId,
          input.packetRevision,
          "receipt",
          "reporter_ephemeral",
        ),
        packetRevision: input.packetRevision,
        deliveryKind: "receipt",
        destination: "reporter_ephemeral",
        templateId: "receipt.private.v1",
        rendererVersion: RENDERER_VERSION,
      },
      { text: `비공개 접수 ${input.bugId}` },
    ),
    deliverBugMessage(
      context,
      {
        teamId: context.scope.teamId,
        bugId: input.bugId,
        reporterId: input.reporterId,
        deliveryKey: bugDeliveryKey(
          input.bugId,
          input.packetRevision,
          "admin_handoff",
          "admin_channel",
        ),
        packetRevision: input.packetRevision,
        deliveryKind: "admin_handoff",
        destination: "admin_channel",
        templateId: "admin_handoff.private.v1",
        rendererVersion: RENDERER_VERSION,
      },
      { text: `비공개 버그 인계 ${input.bugId}` },
    ),
  ]);
}

export async function deliverBugHandoff(
  context: CommunityContext,
  input: { readonly bugId: string; readonly reporterId: string; readonly packetRevision: number },
): Promise<void> {
  for (const destination of ["reporter_ephemeral", "admin_channel"] as const)
    await deliverBugMessage(
      context,
      {
        teamId: context.scope.teamId,
        bugId: input.bugId,
        reporterId: input.reporterId,
        deliveryKey: bugDeliveryKey(
          input.bugId,
          input.packetRevision,
          "admin_handoff",
          destination,
        ),
        packetRevision: input.packetRevision,
        deliveryKind: "admin_handoff",
        destination,
        templateId: "admin_handoff.private.v1",
        rendererVersion: RENDERER_VERSION,
      },
      {
        text:
          destination === "admin_channel"
            ? `비공개 버그 인계 ${input.bugId}`
            : `비공개 접수 ${input.bugId}`,
      },
    );
}
