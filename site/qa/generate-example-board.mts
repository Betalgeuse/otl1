import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { DEFAULT_PALETTE } from "../../src/input.ts";
import { renderBoard } from "../../src/render/board.ts";

const shared = {
  palette: DEFAULT_PALETTE,
  startDate: "2026-09-14",
  endDate: "2026-09-17",
} as const;

const beforeReview = [
  { day: 1, date: "2026-09-14", status: "complete", future: false, today: false },
  { day: 2, date: "2026-09-15", status: "complete", future: false, today: false },
  { day: 3, date: "2026-09-16", status: "written", future: false, today: true },
  { day: 4, date: "2026-09-17", status: "empty", future: true, today: false },
] as const;

const completed = beforeReview.map((cell) => cell.day === 3 ? { ...cell, status: "complete" as const } : cell);

await writeFile(resolve(import.meta.dirname, "../dist/assets/fictional-four-day-board-before-review.png"), await renderBoard({ ...shared, cells: beforeReview }));
await writeFile(resolve(import.meta.dirname, "../dist/assets/fictional-four-day-board-complete.png"), await renderBoard({ ...shared, cells: completed }));
