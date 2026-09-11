import type { Palette } from "./board";
import { DEFAULT_PALETTE, date, InputError, list, object, slackResponseUrl, string } from "./input";
import { type InvitationOperation, invitationCommand } from "./invitations/requests";
import { ownedAction, sharedVisibility } from "./owned-action";
import { modalPalette } from "./palette-modal";
import type { StoreCommand } from "./store";

export type Identity = { readonly teamId: string; readonly userId: string };
export type Operation =
  | InvitationOperation
  | {
      readonly kind: "denied";
      readonly identity: Identity;
      readonly responseUrl: string;
      readonly text: string;
    }
  | {
      readonly kind: "record";
      readonly identity: Identity;
      readonly responseUrl: string;
      readonly action: StoreCommand["action"];
      readonly date: string;
      readonly text: string;
      readonly palette: Palette;
      readonly replace: boolean;
      readonly shared: boolean;
      readonly eventTime: number;
    }
  | {
      readonly kind: "settings";
      readonly identity: Identity;
      readonly responseUrl: string;
      readonly triggerId: string;
      readonly palette: Palette;
      readonly ownerId: string;
      readonly shared: boolean;
      readonly date: string;
    }
  | {
      readonly kind: "errors";
      readonly identity: Identity;
      readonly errors: { readonly [key: string]: string };
    };

export function command(
  body: string,
  context: { readonly today: string; readonly timestamp: number },
): Operation {
  const form = new URLSearchParams(body);
  if (form.get("command") !== "/one") throw new InputError("지원하지 않는 명령입니다.");
  const text = (form.get("text") ?? "").trim();
  const identity = { teamId: string(form.get("team_id")), userId: string(form.get("user_id")) };
  const responseUrl = slackResponseUrl(form.get("response_url"));
  const invitation = invitationCommand(text, { identity, responseUrl });
  if (invitation) return invitation;
  if (text.length > 200 || /[\r\n]/.test(text))
    throw new InputError("오늘의 원씽을 200자 이내 한 줄로 작성해 주세요.");
  const history = /^기록\s+(.+)$/.exec(text);
  const selectedDate = history ? date(history[1]) : context.today;
  return {
    kind: "record",
    identity,
    responseUrl,
    action: !text || text === "보기" || text === "공유" || history ? "get" : "write",
    date: selectedDate,
    text,
    palette: DEFAULT_PALETTE,
    replace: false,
    shared: true,
    eventTime: context.timestamp,
  };
}

export function interaction(
  body: string,
  context: { readonly today: string; readonly timestamp: number },
): Operation {
  const payload = new URLSearchParams(body).get("payload");
  if (!payload) throw new InputError("요청 내용이 없습니다.");
  const data = object(JSON.parse(payload));
  const identity = { teamId: string(object(data.team).id), userId: string(object(data.user).id) };
  if (data.type === "view_submission") {
    const view = object(data.view);
    if (view.callback_id !== "palette") throw new InputError("지원하지 않는 설정입니다.");
    const rawMetadata = string(view.private_metadata);
    if (rawMetadata.startsWith("https://"))
      return {
        kind: "denied",
        identity,
        responseUrl: slackResponseUrl(rawMetadata),
        text: "‘내 상태’로 보드를 다시 열고 색상 변경을 눌러 주세요.",
      };
    const metadata = object(JSON.parse(rawMetadata));
    const responseUrl = slackResponseUrl(metadata.responseUrl);
    if (string(metadata.ownerId) !== identity.userId)
      return {
        kind: "denied",
        identity,
        responseUrl,
        text: "보드 작성자만 색상을 변경할 수 있습니다.",
      };
    const shared = sharedVisibility(metadata.shared);
    const selectedDate = date(metadata.date);
    const result = modalPalette(object(view.state).values);
    if ("errors" in result) return { kind: "errors", identity, errors: result.errors };
    return {
      kind: "record",
      identity,
      responseUrl,
      action: "palette",
      date: selectedDate,
      text: "",
      palette: result,
      replace: true,
      shared,
      eventTime: context.timestamp,
    };
  }
  if (data.type !== "block_actions") throw new InputError("지원하지 않는 동작입니다.");
  const action = object(list(data.actions)[0]);
  const responseUrl = slackResponseUrl(data.response_url);
  if (!["settings", "complete", "reopen"].includes(string(action.action_id)))
    throw new InputError("지원하지 않는 동작입니다.");
  const target = ownedAction(
    action.value,
    {
      actorId: identity.userId,
      today: context.today,
      ephemeral: data.container !== undefined && object(data.container).is_ephemeral === true,
    },
    action.action_id === "settings",
  );
  if (!target)
    return {
      kind: "denied",
      identity,
      responseUrl,
      text: "보드 작성자만 변경할 수 있습니다. 본인 보드는 ‘내 상태’로 다시 열어 주세요.",
    };
  if (action.action_id === "settings")
    return {
      kind: "settings",
      identity,
      responseUrl,
      triggerId: string(data.trigger_id),
      palette: target.palette,
      ownerId: target.ownerId,
      date: target.date,
      shared: target.shared,
    };
  if (action.action_id !== "complete" && action.action_id !== "reopen")
    throw new InputError("지원하지 않는 동작입니다.");
  const actionTime = Number(action.action_ts);
  if (!Number.isFinite(actionTime) || Math.abs(actionTime - context.timestamp) > 300)
    throw new InputError("동작 시간이 올바르지 않습니다.");
  return {
    kind: "record",
    identity,
    responseUrl,
    action: action.action_id,
    date: target.date,
    text: "",
    palette: DEFAULT_PALETTE,
    replace: true,
    shared: target.shared,
    eventTime: actionTime,
  };
}
