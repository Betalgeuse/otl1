import type { Board, Cell } from "./board";
import { date, InputError, list, object, palette, string } from "./input";
import { sign, verify } from "./signing";

export type BoardLinkConfig = {
  readonly baseUrl: string;
  readonly secret: string;
  readonly today: string;
};

export async function boardLink(board: Board, config: BoardLinkConfig): Promise<string> {
  const serialized = JSON.stringify({
    startDate: board.startDate,
    // Keep global Day numbering without exposing a Slack identity or goal text.
    origin: board.cells[0]
      ? new Date(
          Date.parse(`${board.cells[0].date}T00:00:00Z`) - (board.cells[0].day - 1) * 86400000,
        )
          .toISOString()
          .slice(0, 10)
      : board.startDate,
    today: config.today,
    cells: board.cells.map((cell) => ({ date: cell.date, status: cell.status })),
    palette: board.palette,
    expires: Math.floor(Date.now() / 1000) + 7 * 86400,
  });
  const data = btoa(serialized).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  return `${config.baseUrl}/board/${data}.${await sign(data, config.secret)}.png`;
}

export async function readBoardLink(token: string, secret: string): Promise<Board> {
  if (token.length > 6000) throw new InputError("보드 주소가 너무 깁니다.");
  const [data, signature, extension, extra] = token.split(".");
  if (
    !data ||
    !signature ||
    extension !== "png" ||
    extra ||
    !(await verify(data, signature, secret))
  )
    throw new InputError("보드 주소가 유효하지 않습니다.");
  const decoded = object(JSON.parse(atob(data.replaceAll("-", "+").replaceAll("_", "/"))));
  if (typeof decoded.expires !== "number" || decoded.expires < Date.now() / 1000)
    throw new InputError(
      "보드 주소가 만료되었습니다. 채널에 ‘내 상태’라고 입력해 다시 확인해 주세요.",
    );
  const origin = Date.parse(`${date(decoded.origin)}T00:00:00Z`);
  const today = date(decoded.today);
  const todayStamp = Date.parse(`${today}T00:00:00Z`);
  let previous = 0;
  const cells = list(decoded.cells).map((value): Cell => {
    const cell = object(value);
    const status = string(cell.status);
    if (status !== "empty" && status !== "written" && status !== "complete")
      throw new InputError("잘못된 칸 상태입니다.");
    const cellDate = date(cell.date);
    const stamp = Date.parse(`${cellDate}T00:00:00Z`);
    const day = Math.floor((stamp - origin) / 86_400_000) + 1;
    if (day <= previous || day < 1 || stamp > todayStamp + 14 * 86_400_000)
      throw new InputError("잔디 날짜 순서가 올바르지 않습니다.");
    previous = day;
    return {
      day,
      date: cellDate,
      status,
      future: stamp > todayStamp,
      optional: false,
      today: stamp === todayStamp,
    };
  });
  if (cells.length < 1 || cells.length > 8) throw new InputError("잔디 칸 수가 올바르지 않습니다.");
  return {
    cells,
    palette: palette(decoded.palette),
    startDate: date(decoded.startDate),
    endDate: cells.at(-1)?.date ?? today,
  };
}
