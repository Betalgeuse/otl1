import { InputError } from "../input";
import { reply } from "../slack-api";
import { StoreError } from "../store";
import type { InvitationOperation } from "./requests";
import { personEmail } from "./slack-person";
import type { InvitationStore } from "./store";
import { emailHash, makeInvitation, tokenHash } from "./tokens";

type Services = {
  readonly store: InvitationStore;
  readonly botToken: string;
  readonly secret: string;
};

export async function processInvitation(
  operation: InvitationOperation,
  services: Services,
): Promise<void> {
  try {
    const text = await invitationText(operation, services);
    await reply(operation.responseUrl, {
      response_type: "ephemeral",
      replace_original: false,
      text,
      blocks: [{ type: "section", text: { type: "plain_text", text } }],
    });
  } catch (error) {
    const text =
      error instanceof InputError
        ? error.message
        : error instanceof StoreError && error.code === "access"
          ? "초대를 수락한 참여자만 사용할 수 있습니다. /one 가입 뒤에 받은 초대 코드를 입력해 주세요."
          : "초대 처리를 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.";
    if (
      !(error instanceof InputError) &&
      !(error instanceof StoreError && error.code === "access")
    ) {
      console.error(
        JSON.stringify({
          event: "invitation.operation.failed",
          errorType: error instanceof Error ? error.name : "Unknown",
        }),
      );
    }
    try {
      await reply(operation.responseUrl, {
        response_type: "ephemeral",
        replace_original: false,
        text,
      });
    } catch (deliveryError) {
      console.error(
        JSON.stringify({
          event: "invitation.feedback.failed",
          errorType: deliveryError instanceof Error ? deliveryError.name : "Unknown",
        }),
      );
    }
  }
}

async function invitationText(operation: InvitationOperation, services: Services): Promise<string> {
  const identity = { workspace: operation.identity.teamId, user: operation.identity.userId };
  const person = { workspaceId: identity.workspace, userId: identity.user };
  if (operation.action === "redeem") {
    const verifiedEmail = await personEmail(person, services.botToken);
    const status = await services.store.redeem(identity, {
      emailHash: await emailHash(verifiedEmail, services.secret),
      tokenHash: await tokenHash(operation.argument),
    });
    switch (status) {
      case "joined":
        return "초대 수락이 완료됐습니다. /one 뒤에 오늘의 원씽을 한 문장으로 작성해 보세요.";
      case "already_joined":
        return "이미 참여 중입니다. /one으로 내 기록을 확인해 주세요.";
      case "wrong_recipient":
        return "초대받은 이메일과 현재 Slack 계정 이메일이 다릅니다.";
      case "expired":
        return "이번 초대는 만료됐습니다. 초대한 사람에게 새 초대를 요청해 주세요.";
      case "invalid":
        return "사용할 수 없는 초대 코드입니다. 초대한 사람에게 확인해 주세요.";
      default:
        return exhaustive(status);
    }
  }
  const membership = await services.store.member(identity.workspace, identity.user);
  if (!membership.admitted)
    throw new InputError(
      "기존 참여자의 초대가 필요합니다. /one 가입 뒤에 받은 초대 코드를 입력해 주세요.",
    );
  switch (operation.action) {
    case "status":
      return `${membership.month} 초대권: ${membership.remaining}장\n초대권은 매월 1장이고 이월되지 않습니다.\n/one 초대 이메일로 초대를 만들 수 있습니다.`;
    case "issue": {
      const verifiedEmail = await personEmail(person, services.botToken);
      if (verifiedEmail === operation.argument)
        throw new InputError("자신에게는 초대를 발급할 수 없습니다.");
      const invitation = await makeInvitation(
        { ...person, email: operation.argument, month: membership.month },
        services.secret,
      );
      const result = await services.store.issue(
        { ...identity, month: membership.month },
        invitation,
      );
      switch (result.status) {
        case "issued":
        case "existing":
          return `초대 대상: ${operation.argument}\n초대 코드: ${invitation.token}\n유효 기간: 이번 달 말까지(한국 시간)\n\n상대방에게 직접 코드를 전달해 주세요. 운영자의 Slack 초대 승인 후 상대방이 /one 가입 코드로 수락하면 됩니다.\n같은 대상에게 다시 조회해도 추가 초대권은 사용하지 않습니다.`;
        case "used":
          return "이 초대는 이미 수락됐습니다. 다음 달에 새 초대권 1장이 생깁니다.";
        case "quota_used":
          return "이번 달 초대권을 이미 사용했습니다. 다음 달에 다시 초대할 수 있습니다.";
        case "month_changed":
          return "월이 바뀌었습니다. 초대 명령을 다시 실행해 주세요.";
        default:
          return exhaustive(result.status);
      }
    }
    case "check": {
      if (!membership.founder)
        throw new InputError("초대 확인은 초기 운영자만 사용할 수 있습니다.");
      const result = await services.store.check(
        identity,
        await emailHash(operation.argument, services.secret),
      );
      return result.valid
        ? `유효한 초대가 있습니다.\n대상: ${operation.argument}\n초대한 멤버 ID: ${result.inviterId}\nSlack 초대 요청의 이메일과 일치할 때 승인해 주세요.`
        : "사용 가능한 초대가 없습니다. Slack 초대를 승인하지 마세요.";
    }
    default:
      return exhaustive(operation.action);
  }
}

function exhaustive(value: never): never {
  throw new InputError(`Unsupported invitation operation: ${String(value)}`);
}
