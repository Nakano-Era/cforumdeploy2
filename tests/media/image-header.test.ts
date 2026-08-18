import { describe, expect, it } from "vitest";
import {
  inspectImageHeader,
  UnsafeImageError,
  validateImageHeader,
} from "@/worker/media/image-header";

function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10], 0);
  new DataView(bytes.buffer).setUint32(8, 13, false);
  bytes.set([73, 72, 68, 82], 12);
  new DataView(bytes.buffer).setUint32(16, width, false);
  new DataView(bytes.buffer).setUint32(20, height, false);
  return bytes;
}

function jpeg(width: number, height: number): Uint8Array {
  return new Uint8Array([
    0xff,
    0xd8,
    0xff,
    0xe0,
    0x00,
    0x02,
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08,
    (height >>> 8) & 0xff,
    height & 0xff,
    (width >>> 8) & 0xff,
    width & 0xff,
    0x03,
    0x01,
    0x11,
    0x00,
    0x02,
    0x11,
    0x00,
    0x03,
    0x11,
    0x00,
  ]);
}

function webpVp8x(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(30);
  bytes.set([82, 73, 70, 70], 0); // RIFF
  new DataView(bytes.buffer).setUint32(4, 22, true);
  bytes.set([87, 69, 66, 80], 8); // WEBP
  bytes.set([86, 80, 56, 88], 12); // VP8X
  new DataView(bytes.buffer).setUint32(16, 10, true);
  const widthMinusOne = width - 1;
  const heightMinusOne = height - 1;
  bytes.set(
    [
      widthMinusOne & 0xff,
      (widthMinusOne >>> 8) & 0xff,
      (widthMinusOne >>> 16) & 0xff,
    ],
    24,
  );
  bytes.set(
    [
      heightMinusOne & 0xff,
      (heightMinusOne >>> 8) & 0xff,
      (heightMinusOne >>> 16) & 0xff,
    ],
    27,
  );
  return bytes;
}

describe("bounded image magic and dimension parser", () => {
  it("reads PNG magic and IHDR dimensions", () => {
    expect(inspectImageHeader(png(1920, 1080))).toEqual({
      mimeType: "image/png",
      width: 1920,
      height: 1080,
    });
  });

  it("walks JPEG segments to a start-of-frame marker", () => {
    expect(inspectImageHeader(jpeg(2048, 1365))).toEqual({
      mimeType: "image/jpeg",
      width: 2048,
      height: 1365,
    });
  });

  it("reads WebP VP8X dimensions", () => {
    expect(inspectImageHeader(webpVp8x(640, 360))).toEqual({
      mimeType: "image/webp",
      width: 640,
      height: 360,
    });
  });

  it("rejects unsupported or disguised bytes", () => {
    expect(() => inspectImageHeader(new TextEncoder().encode("<svg></svg>"))).toThrow(
      UnsafeImageError,
    );
  });

  it("rejects a MIME or declared-dimension mismatch", () => {
    expect(() =>
      validateImageHeader(png(640, 360), {
        mimeType: "image/webp",
        width: 640,
        height: 360,
      }),
    ).toThrow(UnsafeImageError);
    expect(() =>
      validateImageHeader(png(640, 360), {
        mimeType: "image/png",
        width: 641,
        height: 360,
      }),
    ).toThrow(UnsafeImageError);
  });

  it("rejects dimensions above the 24 megapixel safety ceiling", () => {
    expect(() => inspectImageHeader(png(8_000, 4_000))).toThrow(
      UnsafeImageError,
    );
  });

  it("fails closed when a JPEG SOF is absent from the inspected prefix", () => {
    expect(() => inspectImageHeader(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]))).toThrow(
      UnsafeImageError,
    );
  });
});
