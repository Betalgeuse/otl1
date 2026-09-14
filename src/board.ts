import { isWeekend } from "./calendar";
export type Palette = {
  readonly empty: string;
  readonly written: string;
  readonly complete: string;
};

export type Goal = {
  readonly date: string;
  readonly text: string;
  readonly completed: boolean;
};

export type Snapshot = {
  readonly startDate: string;
  readonly goals: readonly Goal[];
  readonly palette: Palette;
};

export type Cell = {
  readonly day: number;
  readonly date: string;
  readonly status: "empty" | "written" | "complete";
  readonly future: boolean;
  readonly optional?: boolean;
  readonly today: boolean;
};

export type Board = {
  readonly cells: readonly Cell[];
  readonly palette: Palette;
  readonly startDate: string;
  readonly endDate: string;
};

const DAY_MS = 86_400_000;

function dayStamp(value: string): number {
  const stamp = Date.parse(`${value}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(stamp)) {
    throw new RangeError("날짜는 YYYY-MM-DD 형식이어야 합니다.");
  }
  if (new Date(stamp).toISOString().slice(0, 10) !== value) {
    throw new RangeError("존재하지 않는 날짜입니다.");
  }
  return stamp / DAY_MS;
}

function isoDate(stamp: number): string {
  return new Date(stamp * DAY_MS).toISOString().slice(0, 10);
}

export function buildBoard(snapshot: Snapshot, today: string, anchor = today): Board {
  const origin = dayStamp(snapshot.startDate);
  const current = dayStamp(today);
  const selected = dayStamp(anchor);
  if (current < origin || selected < origin || selected > current) {
    throw new RangeError("시작일부터 오늘까지의 날짜를 선택해 주세요.");
  }
  const selectedDay = selected - origin + 1;
  const firstDay = selectedDay <= 8 ? 1 : 9 + Math.floor((selectedDay - 9) / 8) * 8;
  const count = current - origin < 4 ? 4 : 8;
  const records = new Map(snapshot.goals.map((goal) => [goal.date, goal]));
  const cells = Array.from({ length: count }, (_, index): Cell => {
    const day = firstDay + index;
    const stamp = origin + day - 1;
    const date = isoDate(stamp);
    const goal = records.get(date);
    return {
      day,
      date,
      status: goal === undefined ? "empty" : goal.completed ? "complete" : "written",
      future: stamp > current,
      optional: goal === undefined && isWeekend(date),
      today: stamp === current,
    };
  }).filter((cell) => !cell.optional);
  return {
    cells,
    palette: snapshot.palette,
    startDate: isoDate(origin + firstDay - 1),
    endDate: isoDate(origin + firstDay + count - 2),
  };
}
