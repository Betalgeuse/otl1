export type Color = readonly [number, number, number];
export type Point = { readonly x: number; readonly y: number };
export type Rect = Point & { readonly width: number; readonly height: number };

export function color(hex: string): Color {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) throw new RangeError("색상은 #RRGGBB 형식이어야 합니다.");
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ];
}

export function contrastingInk(rgb: Color): Color {
  const channels = rgb.map((value) => {
    const scaled = value / 255;
    return scaled <= 0.04045 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
  });
  const [red = 0, green = 0, blue = 0] = channels;
  return red * 0.2126 + green * 0.7152 + blue * 0.0722 > 0.179 ? [0, 0, 0] : [255, 255, 255];
}

// A raster is a mutable drawing buffer. Coordinates are logical pixels at 2x output resolution.
export class Raster {
  readonly pixels: Uint8Array;
  readonly width: number;
  readonly height: number;

  constructor(size: { readonly width: number; readonly height: number }) {
    this.width = size.width * 2;
    this.height = size.height * 2;
    this.pixels = new Uint8Array(this.width * this.height * 3).fill(255);
  }

  rect(rect: Rect, ink: Color): void {
    for (
      let y = Math.max(0, Math.round(rect.y * 2));
      y < Math.min(this.height, Math.round((rect.y + rect.height) * 2));
      y++
    ) {
      for (
        let x = Math.max(0, Math.round(rect.x * 2));
        x < Math.min(this.width, Math.round((rect.x + rect.width) * 2));
        x++
      ) {
        this.pixels.set(ink, (y * this.width + x) * 3);
      }
    }
  }

  square(rect: Rect, ink: Color, radius = 4): void {
    for (let y = 0; y < rect.height * 2; y++) {
      for (let x = 0; x < rect.width * 2; x++) {
        const localX = (x + 0.5) / 2;
        const localY = (y + 0.5) / 2;
        const dx = Math.max(radius - localX, 0, localX - (rect.width - radius));
        const dy = Math.max(radius - localY, 0, localY - (rect.height - radius));
        if (dx * dx + dy * dy <= radius * radius) {
          this.rect({ x: rect.x + x / 2, y: rect.y + y / 2, width: 0.5, height: 0.5 }, ink);
        }
      }
    }
  }

  line(points: readonly [Point, Point], ink: Color, thickness = 3): void {
    const [from, to] = points;
    const steps = Math.max(Math.abs(to.x - from.x), Math.abs(to.y - from.y)) * 2;
    for (let step = 0; step <= steps; step++) {
      const position = steps === 0 ? 0 : step / steps;
      this.rect(
        {
          x: from.x + (to.x - from.x) * position - thickness / 2,
          y: from.y + (to.y - from.y) * position - thickness / 2,
          width: thickness,
          height: thickness,
        },
        ink,
      );
    }
  }
}
