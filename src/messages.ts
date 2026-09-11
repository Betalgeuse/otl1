import { buildBoard, type Snapshot } from "./board";
import { type BoardLinkConfig, boardLink } from "./board-link";
import type { Json } from "./input";

export type MessageOptions = {
  readonly ownerId: string;
  readonly today: string;
  readonly anchor: string;
  readonly link: BoardLinkConfig;
  readonly replace: boolean;
  readonly sharedBy: string | null;
};

export async function boardMessage(snapshot: Snapshot, options: MessageOptions): Promise<Json> {
  const board = buildBoard(snapshot, options.today, options.anchor);
  const active = snapshot.goals.find((goal) => goal.date === options.anchor);
  const complete = board.cells.filter((cell) => cell.status === "complete").length;
  const written = board.cells.filter((cell) => cell.status === "written").length;
  const labels = { empty: "미작성", written: "작성", complete: "완료" } as const;
  const alt = board.cells
    .map((cell) => `Day ${cell.day} ${cell.date}: ${cell.future ? "예정" : labels[cell.status]}`)
    .join(", ");
  const summary = `완료 ${complete} · 작성 중 ${written}`;
  const goalText = active
    ? `${options.anchor}의 원씽\n${active.text}`
    : options.anchor < options.today
      ? `${options.anchor}에는 목표를 작성하지 않았습니다.`
      : "오늘의 원씽을 한 문장으로 시작해 보세요.\n오늘 원씽은 책 10쪽 읽기";
  const actions: Json[] = [];
  if (active && options.anchor <= options.today) {
    actions.push({
      type: "button",
      action_id: active.completed ? "reopen" : "complete",
      text: { type: "plain_text", text: active.completed ? "완료 취소" : "완료하기" },
      value: JSON.stringify({
        ownerId: options.ownerId,
        date: active.date,
        shared: options.sharedBy !== null,
      }),
    });
  }
  actions.push({
    type: "button",
    action_id: "settings",
    text: { type: "plain_text", text: "색상 설정" },
    value: JSON.stringify({
      ownerId: options.ownerId,
      date: options.anchor,
      shared: options.sharedBy !== null,
      palette: snapshot.palette,
    }),
  });
  return {
    response_type: options.sharedBy ? "in_channel" : "ephemeral",
    replace_original: options.replace,
    text: `${summary}\n${goalText}\n${alt}`,
    blocks: [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: options.sharedBy ? "함께하는 원씽 잔디" : "나의 원씽 잔디",
        },
      },
      ...(options.sharedBy
        ? [
            {
              type: "context",
              elements: [{ type: "mrkdwn", text: `<@${options.sharedBy}>님의 기록` }],
            },
          ]
        : []),
      {
        type: "context",
        elements: [
          { type: "plain_text", text: `${board.startDate} ~ ${board.endDate} · 한국 시간` },
        ],
      },
      { type: "image", image_url: await boardLink(board, options.link), alt_text: alt },
      { type: "section", text: { type: "plain_text", text: `${summary}\n${goalText}` } },
      ...(options.sharedBy ? [] : [{ type: "actions", elements: actions }]),
      {
        type: "context",
        elements: [
          {
            type: "plain_text",
            text: "— 미작성 · 점 작성 · 체크 완료 · 점선 예정\n이전 날짜 글의 스레드에서 기록을 확인해 주세요. · 완료와 색상은 작성자만 변경할 수 있습니다.",
          },
        ],
      },
    ],
  };
}
