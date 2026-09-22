import { InputError, type Json } from "./input";

export type StatusCard = {
  readonly earlierNotice?: string | null;
  readonly userId: string;
  readonly date: string;
  readonly goal: string | null;
  readonly outcome: "complete" | "partial" | "not_done" | "unknown";
  readonly reflection: string | null;
  readonly rest: boolean;
  readonly undoValue: string | null;
  readonly boardUrl?: string;
  readonly boardDate?: string;
  readonly statusValue?: string;
  readonly settingsValue?: string;
};

export type CommunityChoice = {
  readonly label: string;
  readonly actionId: string;
  readonly value: string;
};

export function slackMention(userId: string): string {
  if (!/^[UW][A-Z0-9]+$/.test(userId)) throw new InputError("Slack 사용자 ID가 아닙니다.");
  return `<@${userId}>`;
}

export function escapeSlackText(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function button(choice: CommunityChoice): Json {
  if (choice.label.length > 75 || choice.value.length > 2000) {
    throw new InputError("버튼 내용이 너무 깁니다.");
  }
  return {
    type: "button",
    text: { type: "plain_text", text: choice.label },
    action_id: choice.actionId,
    value: choice.value,
  };
}

export function communityStatusMessage(input: StatusCard): Json {
  const labels = {
    complete: "완료 ✅",
    partial: "일부 진행 🌱",
    not_done: "아직 못 했어요",
    unknown: "완료 여부 미확인",
  } as const;
  const status = input.rest ? "오늘은 쉬어요 ☕" : labels[input.outcome];
  const text = `${input.date} *ONE THING* · ${status}\n목표: ${input.goal ?? "아직 등록하지 않았어요"}\n후기: ${input.reflection ?? "아직 남기지 않았어요"}`;
  const actions: Json[] = [];
  if (input.undoValue)
    actions.push(button({ label: "되돌리기", actionId: "community_undo", value: input.undoValue }));
  if (input.statusValue)
    actions.push(
      button({ label: "현재 상태 보기", actionId: "community_status", value: input.statusValue }),
    );
  if (input.settingsValue)
    actions.push(
      button({ label: "알림 설정", actionId: "community_settings", value: input.settingsValue }),
    );
  const blocks: Json[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `${slackMention(input.userId)} · ${escapeSlackText(input.date)} *ONE THING* · ${status} · 한국 시간`,
      },
    },
    {
      type: "section",
      text: {
        type: "plain_text",
        text: `목표: ${input.goal ?? "아직 등록하지 않았어요"}\n후기: ${input.reflection ?? "아직 남기지 않았어요"}`.slice(
          0,
          2900,
        ),
      },
    },
  ];
  if (input.boardUrl) {
    const url = new URL(input.boardUrl);
    if (url.protocol !== "https:") throw new InputError("잔디 주소는 HTTPS여야 합니다.");
    blocks.push({
      type: "image",
      image_url: url.href,
      alt_text: `${input.boardDate ?? input.date}까지의 ONE THING 잔디`,
    });
  }
  if (input.boardUrl)
    blocks.push({
      type: "context",
      elements: [
        {
          type: "plain_text",
          text: "주말과 대한민국 공휴일은 선택 참여예요. 목표를 등록하지 않은 선택 참여일은 잔디에 표시하지 않아요.",
        },
      ],
    });
  if (input.earlierNotice)
    blocks.push({ type: "section", text: { type: "mrkdwn", text: input.earlierNotice } });
  if (actions.length) blocks.push({ type: "actions", elements: actions });
  return { text: input.earlierNotice ? `${text}\n\n${input.earlierNotice}` : text, blocks };
}

export function communityConfirmationMessage(
  text: string,
  choices: readonly CommunityChoice[],
  format: "plain_text" | "mrkdwn" = "plain_text",
): Json {
  if (choices.length < 1 || choices.length > 5)
    throw new InputError("확인 선택지는 1~5개여야 합니다.");
  const [heading = "", ...body] = text.split("\n");
  const branded = format === "plain_text" && heading.includes("ONE THING");
  const sections: Json[] = branded
    ? [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: escapeSlackText(heading).replace(/\*?ONE THING\*?/g, "*ONE THING*"),
          },
        },
        ...(body.length
          ? [
              {
                type: "section",
                text: { type: "plain_text", text: body.join("\n").slice(0, 2900) },
              },
            ]
          : []),
      ]
    : [{ type: "section", text: { type: format, text: text.slice(0, 2900) } }];
  return {
    text,
    blocks: [...sections, { type: "actions", elements: choices.map(button) }],
  };
}

export function shoutoutSuggestionMessage(input: {
  readonly userId: string;
  readonly text: string;
  readonly value: string;
}): Json {
  return {
    text: `함께 응원해 주세요! ${input.text}`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `${slackMention(input.userId)}님께 응원 한 번 보내볼까요? 🙌`,
        },
      },
      { type: "section", text: { type: "plain_text", text: input.text.slice(0, 2900) } },
      {
        type: "actions",
        elements: [
          button({
            label: "나도 응원할래요 🙌",
            actionId: "community_shoutout",
            value: input.value,
          }),
        ],
      },
      {
        type: "context",
        elements: [
          {
            type: "plain_text",
            text: "봇의 제안이에요. 직접 응원을 적고 보내면 작성자의 샤라웃으로 전달돼요.",
          },
        ],
      },
    ],
  };
}
