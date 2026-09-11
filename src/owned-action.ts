import type { Palette } from "./board";
import { DEFAULT_PALETTE, date, InputError, object, palette, string } from "./input";

type BoardAction = {
  readonly ownerId: string;
  readonly shared: boolean;
  readonly date: string;
  readonly palette: Palette;
};

export function sharedVisibility(value: unknown): boolean {
  if (typeof value !== "boolean") throw new InputError("공개 범위를 확인할 수 없습니다.");
  return value;
}

export function ownedAction(
  value: unknown,
  context: {
    readonly actorId: string;
    readonly today: string;
    readonly ephemeral: boolean;
  },
  settings: boolean,
): BoardAction | null {
  const raw = string(value);
  const legacyDate = /^\d{4}-\d{2}-\d{2}$/.test(raw);
  const data = legacyDate ? {} : object(JSON.parse(raw));
  if (!("ownerId" in data)) {
    if (!context.ephemeral) return null;
    return {
      ownerId: context.actorId,
      shared: false,
      date: settings ? context.today : date(raw),
      palette: settings ? palette(data) : DEFAULT_PALETTE,
    };
  }
  if (string(data.ownerId) !== context.actorId) return null;
  const shared = sharedVisibility(data.shared);
  if (shared === context.ephemeral) return null;
  return {
    ownerId: context.actorId,
    shared,
    date: date(data.date),
    palette: settings ? palette(data.palette) : DEFAULT_PALETTE,
  };
}
