import type { Board, Cell } from "../board";
import { label } from "./glyphs";
import { encodePng } from "./png";
import { color, contrastingInk, Raster } from "./raster";

const TEXT = color("#24292F");
const SECONDARY = color("#57606A");
const BORDER = color("#D0D7DE");
const TODAY = color("#0969DA");
const BRAND_RED = color("#ED1C24");
const COLUMNS = 8;
const COLUMN_WIDTH = 76;
const ROW_HEIGHT = 130;
const BRAND_HEIGHT = 44;
const BOARD_WIDTH = COLUMNS * COLUMN_WIDTH + 16;

function drawBrand(raster: Raster): void {
  const center = BOARD_WIDTH / 2;
  for (const [offset, glyph, ink] of [
    [-33, "O", TEXT],
    [-11, "T", TEXT],
    [11, "1", BRAND_RED],
    [33, "L", TEXT],
  ] as const) {
    label(raster, glyph, { center: { x: center + offset, y: 8 }, ink, scale: 4 });
  }
}

function drawCell(
  raster: Raster,
  cell: Cell,
  placement: { readonly index: number; readonly board: Board },
): void {
  const x = 8 + (placement.index % COLUMNS) * COLUMN_WIDTH;
  const y = BRAND_HEIGHT + 12 + Math.floor(placement.index / COLUMNS) * ROW_HEIGHT;
  const centerX = x + 38;
  label(raster, "DAY", { center: { x: centerX, y }, ink: SECONDARY });
  label(raster, String(cell.day), { center: { x: centerX, y: y + 20 }, ink: TEXT });
  const month = Number(cell.date.slice(5, 7));
  const day = Number(cell.date.slice(8, 10));
  label(raster, `${month}/${day}`, { center: { x: centerX, y: y + 42 }, ink: SECONDARY });
  const box = { x: x + 13, y: y + 66, width: 50, height: 50 };
  if (cell.today) {
    raster.square({ x: box.x - 4, y: box.y - 4, width: 58, height: 58 }, TODAY, 7);
    raster.square({ x: box.x - 2, y: box.y - 2, width: 54, height: 54 }, [255, 255, 255], 5);
  }
  const fill = color(placement.board.palette[cell.future ? "empty" : cell.status]);
  raster.square(box, BORDER);
  raster.square({ x: box.x + 1, y: box.y + 1, width: 48, height: 48 }, fill, 3);
  const ink = contrastingInk(fill);
  if (cell.future) {
    raster.square(box, fill);
    for (let offset = 6; offset < 46; offset += 10) {
      raster.rect({ x: box.x + offset, y: box.y, width: 5, height: 1.5 }, ink);
      raster.rect({ x: box.x + offset, y: box.y + 48.5, width: 5, height: 1.5 }, ink);
      raster.rect({ x: box.x, y: box.y + offset, width: 1.5, height: 5 }, ink);
      raster.rect({ x: box.x + 48.5, y: box.y + offset, width: 1.5, height: 5 }, ink);
    }
    return;
  }
  switch (cell.status) {
    case "empty":
      if (cell.optional) {
        label(raster, "O", { center: { x: centerX, y: box.y + 18 }, ink });
        return;
      }
      raster.rect({ x: box.x + 18, y: box.y + 23, width: 14, height: 4 }, ink);
      return;
    case "written":
      raster.square({ x: box.x + 21, y: box.y + 21, width: 8, height: 8 }, ink);
      return;
    case "complete":
      raster.line(
        [
          { x: box.x + 14, y: box.y + 25 },
          { x: box.x + 22, y: box.y + 33 },
        ],
        ink,
        4,
      );
      raster.line(
        [
          { x: box.x + 22, y: box.y + 33 },
          { x: box.x + 37, y: box.y + 17 },
        ],
        ink,
        4,
      );
      return;
    default:
      assertNever(cell.status);
  }
}

function assertNever(value: never): never {
  throw new TypeError(`Unknown board status: ${value}`);
}

export async function renderBoard(board: Board): Promise<Uint8Array> {
  const raster = new Raster({
    width: BOARD_WIDTH,
    height: BRAND_HEIGHT + Math.ceil(board.cells.length / COLUMNS) * ROW_HEIGHT + 12,
  });
  drawBrand(raster);
  for (const [index, cell] of board.cells.entries()) drawCell(raster, cell, { index, board });
  return encodePng(raster.pixels, raster);
}
