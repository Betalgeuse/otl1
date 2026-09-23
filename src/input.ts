import type { Palette } from "./board";

export class InputError extends Error {
  override readonly name = "InputError";
}

export class BodySizeError extends InputError {}

export async function readBody(request: Request): Promise<string> {
  const reader = request.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 16384) {
        await reader.cancel();
        throw new BodySizeError("Request too large");
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const buffer = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(buffer);
}

export type Json =
  | null
  | boolean
  | number
  | string
  | readonly Json[]
  | { readonly [key: string]: Json };

export function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new InputError("잘못된 요청입니다.");
  }
  return Object.fromEntries(Object.entries(value));
}

export function string(value: unknown): string {
  if (typeof value !== "string") throw new InputError("문자열이 필요합니다.");
  return value;
}

export function list(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) throw new InputError("목록이 필요합니다.");
  return value;
}

export function date(value: unknown): string {
  const result = string(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result))
    throw new InputError("날짜는 YYYY-MM-DD로 입력해 주세요.");
  const time = Date.parse(`${result}T00:00:00Z`);
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== result) {
    throw new InputError("올바른 날짜를 입력해 주세요.");
  }
  return result;
}

export function koreaDate(timestamp: number): string {
  return new Date(timestamp * 1000 + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export function koreaCalendarDate(timestamp: number): string {
  return new Date(timestamp * 1000 + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export const DEFAULT_PALETTE: Palette = {
  empty: "#EBEDF0",
  written: "#9BE9A8",
  complete: "#216E39",
};

export function color(value: unknown): string {
  const result = string(value).trim();
  if (!/^#[0-9a-f]{6}$/i.test(result))
    throw new InputError("#12AB34처럼 여섯 자리 색상 코드를 입력해 주세요.");
  return result.toUpperCase();
}

export function palette(value: unknown): Palette {
  const data = object(value);
  return { empty: color(data.empty), written: color(data.written), complete: color(data.complete) };
}

export function slackResponseUrl(value: unknown): string {
  const result = string(value);
  let url: URL;
  try {
    url = new URL(result);
  } catch {
    throw new InputError("응답 주소가 올바르지 않습니다.");
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "hooks.slack.com" ||
    url.port ||
    url.username ||
    url.password
  ) {
    throw new InputError("Slack 응답 주소가 아닙니다.");
  }
  return result;
}
