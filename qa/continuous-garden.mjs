import assert from "node:assert/strict";
import { buildBoard } from "../src/board.ts";
import { boardLink, readBoardLink } from "../src/board-link.ts";
import { renderBoard } from "../src/render/board.ts";

const palette = { empty: "#EBEDF0", written: "#9BE9A8", complete: "#216E39" };
const weekdays = (start, end, status = "complete") => {
  const goals = [];
  for (
    let stamp = Date.parse(`${start}T00:00:00Z`);
    stamp <= Date.parse(`${end}T00:00:00Z`);
    stamp += 86400000
  ) {
    const date = new Date(stamp).toISOString().slice(0, 10);
    const day = new Date(stamp).getUTCDay();
    if (day !== 0 && day !== 6) goals.push({ date, text: date, completed: status === "complete" });
  }
  return goals;
};

const day4 = buildBoard(
  { startDate: "2026-09-14", palette, goals: weekdays("2026-09-14", "2026-09-17") },
  "2026-09-17",
);
assert.equal(day4.cells.length, 4);
assert.deepEqual(
  day4.cells.map((c) => c.day),
  [1, 2, 3, 4],
);
const day5 = buildBoard(
  { startDate: "2026-09-14", palette, goals: weekdays("2026-09-14", "2026-09-18") },
  "2026-09-18",
);
assert.equal(day5.cells.length, 8);
assert.deepEqual(
  day5.cells.slice(0, 5).map((c) => c.day),
  [1, 2, 3, 4, 5],
);

const history = weekdays("2026-09-10", "2026-09-17").filter((goal) => goal.date !== "2026-09-14");
history.push({ date: "2026-09-18", text: "today", completed: false });
const day9 = buildBoard({ startDate: "2026-09-10", palette, goals: history }, "2026-09-18");
assert.ok(day9.cells.length <= 8);
assert.equal(day9.cells.at(-1).date, "2026-09-18");
assert.equal(day9.cells.at(-1).status, "written");
assert.equal(day9.cells.at(-1).today, true);
assert.ok(day9.cells.some((c) => c.date === "2026-09-15" && c.status === "complete"));
assert.ok(day9.cells.some((c) => c.date === "2026-09-14" && c.status === "empty"));
const completedToday = buildBoard(
  {
    startDate: "2026-09-10",
    palette,
    goals: history.map((goal) =>
      goal.date === "2026-09-18" ? { ...goal, completed: true } : goal,
    ),
  },
  "2026-09-18",
);
assert.equal(completedToday.cells.at(-1).status, "complete");
assert.ok(day9.cells.every((c) => c.date <= "2026-09-18"));
assert.deepEqual(
  day9.cells.map((c) => c.date),
  day9.cells.map((c) => c.date).toSorted(),
);
assert.equal(new Set(day9.cells.map((c) => c.date)).size, day9.cells.length);

const weekend = buildBoard(
  {
    startDate: "2026-09-10",
    palette,
    goals: [...history, { date: "2026-09-13", text: "optional", completed: true }],
  },
  "2026-09-18",
);
assert.equal(weekend.cells.length, 8);
assert.ok(weekend.cells.some((c) => c.date === "2026-09-13" && c.status === "complete"));
assert.ok(!weekend.cells.some((c) => c.date === "2026-09-12"));

const url = await boardLink(day9, {
  baseUrl: "https://test.example",
  secret: "secret",
  today: "2026-09-18",
});
const decoded = await readBoardLink(url.split("/board/")[1], "secret");
assert.deepEqual(decoded.cells, day9.cells);
const png = await renderBoard(decoded);
assert.deepEqual([...png.slice(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
assert.ok(png.length > 1000);
console.log(
  "PASS continuous garden grows 4-to-8, rolls without reset, keeps weekend participation, signs and renders PNG",
);
