import { InputError } from "./input";

const CANVAS_URL = /^https:\/\/[a-z0-9-]+\.slack\.com\/docs\/[A-Z0-9]+\/[A-Z0-9]+$/;

export function slackCanvasUrl(value: string | undefined): string {
  if (!value || !CANVAS_URL.test(value)) throw new InputError("Slack Canvas 설정을 확인해 주세요.");
  return value;
}

export function slackCanvasId(value: string | undefined): string {
  if (!value || !/^F[A-Z0-9]+$/.test(value))
    throw new InputError("Slack Canvas 설정을 확인해 주세요.");
  return value;
}
