import { type Board, buildBoard, type Snapshot } from "./board";
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
    throw new InputError("보드 주소가 만료되었습니다. /one으로 다시 확인해 주세요.");
  const snapshot: Snapshot = {
    startDate: date(decoded.origin),
    palette: palette(decoded.palette),
    goals: list(decoded.cells).flatMap((value) => {
      const cell = object(value);
      const status = string(cell.status);
      if (status === "empty") return [];
      if (status !== "written" && status !== "complete")
        throw new InputError("잘못된 칸 상태입니다.");
      return [{ date: date(cell.date), text: "", completed: status === "complete" }];
    }),
  };
  return buildBoard(snapshot, date(decoded.today), date(decoded.startDate));
}
