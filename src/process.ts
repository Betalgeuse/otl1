import { InputError } from "./input";
import { boardMessage } from "./messages";
import type { Operation } from "./requests";
import { reply } from "./slack-api";
import { type Store, StoreError } from "./store";

export type Services = {
  readonly store: Store;
  readonly baseUrl: string;
  readonly boardSecret: string;
  readonly today: string;
};

export async function processRecord(
  operation: Extract<Operation, { readonly kind: "record" }>,
  services: Services,
): Promise<void> {
  let phase: "database" | "reply" = "database";
  try {
    const snapshot = await services.store.execute({
      ...operation.identity,
      today: services.today,
      action: operation.action,
      date: operation.date,
      text: operation.text,
      palette: operation.palette,
      eventTime: operation.eventTime,
    });
    phase = "reply";
    await reply(
      operation.responseUrl,
      await boardMessage(snapshot, {
        today: services.today,
        anchor: operation.date,
        ownerId: operation.identity.userId,
        replace: operation.replace,
        sharedBy: operation.shared ? operation.identity.userId : null,
        link: { baseUrl: services.baseUrl, secret: services.boardSecret, today: services.today },
      }),
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "slack.operation.failed",
        phase,
        errorType: error instanceof Error ? error.name : "Unknown",
      }),
    );
    const text =
      error instanceof StoreError && error.code === "access"
        ? "기존 참여자의 초대가 필요합니다. /one 가입 뒤에 받은 초대 코드를 입력해 주세요."
        : error instanceof RangeError || error instanceof InputError
          ? error.message
          : "처리를 확인하지 못했습니다. /one으로 기록을 확인한 뒤 다시 시도해 주세요.";
    try {
      await reply(operation.responseUrl, {
        response_type: "ephemeral",
        replace_original: false,
        text,
      });
    } catch (deliveryError) {
      console.error(
        JSON.stringify({
          event: "slack.feedback.failed",
          errorType: deliveryError instanceof Error ? deliveryError.name : "Unknown",
        }),
      );
    }
  }
}
