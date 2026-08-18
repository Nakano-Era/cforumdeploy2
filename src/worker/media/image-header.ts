import type { SupportedImageMimeType } from "@/worker/media/constants";
import {
  MAX_IMAGE_DIMENSION,
  MAX_IMAGE_PIXELS,
} from "@/worker/media/constants";

export interface InspectedImage {
  mimeType: SupportedImageMimeType;
  width: number;
  height: number;
}

export class UnsafeImageError extends Error {
  constructor() {
    super("unsafe_image");
    this.name = "UnsafeImageError";
  }
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function uint16Be(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] << 8) | bytes[offset + 1];
}

function uint16Le(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function uint24Le(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset] |
    (bytes[offset + 1] << 8) |
    (bytes[offset + 2] << 16)
  );
}

function uint32Le(bytes: Uint8Array, offset: number): number {
  return new DataView(
    bytes.buffer,
    bytes.byteOffset + offset,
    4,
  ).getUint32(0, true);
}

function inspectPng(bytes: Uint8Array): InspectedImage | null {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length < 24 || !signature.every((value, i) => bytes[i] === value)) {
    return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(8, false) !== 13 || ascii(bytes, 12, 4) !== "IHDR") {
    throw new UnsafeImageError();
  }
  return {
    mimeType: "image/png",
    width: view.getUint32(16, false),
    height: view.getUint32(20, false),
  };
}

const JPEG_START_OF_FRAME = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce,
  0xcf,
]);

function inspectJpeg(bytes: Uint8Array): InspectedImage | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 3 < bytes.length) {
    if (bytes[offset] !== 0xff) throw new UnsafeImageError();
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) break;
    const marker = bytes[offset];
    offset += 1;
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
    if (offset + 2 > bytes.length) break;
    const segmentLength = uint16Be(bytes, offset);
    if (segmentLength < 2) throw new UnsafeImageError();
    if (JPEG_START_OF_FRAME.has(marker)) {
      if (segmentLength < 7 || offset + 7 > bytes.length) {
        throw new UnsafeImageError();
      }
      return {
        mimeType: "image/jpeg",
        height: uint16Be(bytes, offset + 3),
        width: uint16Be(bytes, offset + 5),
      };
    }
    offset += segmentLength;
  }
  throw new UnsafeImageError();
}

function inspectWebp(bytes: Uint8Array): InspectedImage | null {
  if (
    bytes.length < 20 ||
    ascii(bytes, 0, 4) !== "RIFF" ||
    ascii(bytes, 8, 4) !== "WEBP"
  ) {
    return null;
  }

  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const kind = ascii(bytes, offset, 4);
    const chunkLength = uint32Le(bytes, offset + 4);
    const dataOffset = offset + 8;
    if (kind === "VP8X") {
      if (chunkLength < 10 || dataOffset + 10 > bytes.length) {
        throw new UnsafeImageError();
      }
      return {
        mimeType: "image/webp",
        width: uint24Le(bytes, dataOffset + 4) + 1,
        height: uint24Le(bytes, dataOffset + 7) + 1,
      };
    }
    if (kind === "VP8L") {
      if (
        chunkLength < 5 ||
        dataOffset + 5 > bytes.length ||
        bytes[dataOffset] !== 0x2f
      ) {
        throw new UnsafeImageError();
      }
      const bits = uint32Le(bytes, dataOffset + 1);
      return {
        mimeType: "image/webp",
        width: (bits & 0x3fff) + 1,
        height: ((bits >>> 14) & 0x3fff) + 1,
      };
    }
    if (kind === "VP8 ") {
      if (
        chunkLength < 10 ||
        dataOffset + 10 > bytes.length ||
        bytes[dataOffset + 3] !== 0x9d ||
        bytes[dataOffset + 4] !== 0x01 ||
        bytes[dataOffset + 5] !== 0x2a
      ) {
        throw new UnsafeImageError();
      }
      return {
        mimeType: "image/webp",
        width: uint16Le(bytes, dataOffset + 6) & 0x3fff,
        height: uint16Le(bytes, dataOffset + 8) & 0x3fff,
      };
    }
    const paddedLength = chunkLength + (chunkLength % 2);
    if (dataOffset + paddedLength > bytes.length) break;
    offset = dataOffset + paddedLength;
  }
  throw new UnsafeImageError();
}

function assertSafeDimensions(width: number, height: number): void {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    width > MAX_IMAGE_DIMENSION ||
    height > MAX_IMAGE_DIMENSION ||
    width * height > MAX_IMAGE_PIXELS
  ) {
    throw new UnsafeImageError();
  }
}

export function inspectImageHeader(bytes: Uint8Array): InspectedImage {
  const inspected = inspectPng(bytes) ?? inspectJpeg(bytes) ?? inspectWebp(bytes);
  if (!inspected) throw new UnsafeImageError();
  assertSafeDimensions(inspected.width, inspected.height);
  return inspected;
}

export function validateImageHeader(
  bytes: Uint8Array,
  expected: InspectedImage,
): InspectedImage {
  const inspected = inspectImageHeader(bytes);
  if (
    inspected.mimeType !== expected.mimeType ||
    inspected.width !== expected.width ||
    inspected.height !== expected.height
  ) {
    throw new UnsafeImageError();
  }
  return inspected;
}
