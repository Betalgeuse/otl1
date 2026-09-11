import type { Color, Point, Raster } from "./raster";

const GLYPHS: Readonly<Record<string, readonly number[]>> = {
  "0": [14, 17, 19, 21, 25, 17, 14],
  "1": [4, 12, 4, 4, 4, 4, 14],
  "2": [14, 17, 1, 2, 4, 8, 31],
  "3": [30, 1, 1, 14, 1, 1, 30],
  "4": [2, 6, 10, 18, 31, 2, 2],
  "5": [31, 16, 16, 30, 1, 1, 30],
  "6": [14, 16, 16, 30, 17, 17, 14],
  "7": [31, 1, 2, 4, 8, 8, 8],
  "8": [14, 17, 17, 14, 17, 17, 14],
  "9": [14, 17, 17, 15, 1, 1, 14],
  D: [30, 17, 17, 17, 17, 17, 30],
  A: [14, 17, 17, 31, 17, 17, 17],
  Y: [17, 17, 10, 4, 4, 4, 4],
  "/": [1, 2, 2, 4, 8, 8, 16],
};

export function label(
  raster: Raster,
  text: string,
  style: { readonly center: Point; readonly ink: Color },
): void {
  const pitch = text.length > 6 ? 10 : 12;
  const width = text.length * pitch - (pitch - 10);
  for (let index = 0; index < text.length; index++) {
    const glyph = GLYPHS[text.charAt(index)];
    if (glyph === undefined) throw new RangeError(`Unsupported board glyph: ${text.charAt(index)}`);
    for (const [row, bits] of glyph.entries()) {
      for (let column = 0; column < 5; column++) {
        if ((bits & (1 << (4 - column))) !== 0) {
          raster.rect(
            {
              x: style.center.x - width / 2 + index * pitch + column * 2,
              y: style.center.y + row * 2,
              width: 2,
              height: 2,
            },
            style.ink,
          );
        }
      }
    }
  }
}
