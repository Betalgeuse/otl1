function concat(parts: readonly Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(data.length + 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, data.length);
  bytes.set(new TextEncoder().encode(type), 4);
  bytes.set(data, 8);
  let crc = 0xffffffff;
  for (const value of bytes.subarray(4, bytes.length - 4)) {
    crc ^= value;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ ((crc & 1) === 1 ? 0xedb88320 : 0);
    }
  }
  view.setUint32(bytes.length - 4, (crc ^ 0xffffffff) >>> 0);
  return bytes;
}

export async function encodePng(
  pixels: Uint8Array,
  size: { readonly width: number; readonly height: number },
): Promise<Uint8Array> {
  const { width, height } = size;
  const scanlines = new Uint8Array(height * (width * 3 + 1));
  for (let row = 0; row < height; row++) {
    scanlines.set(
      pixels.subarray(row * width * 3, (row + 1) * width * 3),
      row * (width * 3 + 1) + 1,
    );
  }
  const compressed = new Response(scanlines).body?.pipeThrough(new CompressionStream("deflate"));
  if (compressed === undefined) throw new TypeError("PNG scanline stream is unavailable.");
  const data = new Uint8Array(await new Response(compressed).arrayBuffer());
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header.set([8, 2, 0, 0, 0], 8);
  return concat([
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", data),
    chunk("IEND", new Uint8Array()),
  ]);
}
