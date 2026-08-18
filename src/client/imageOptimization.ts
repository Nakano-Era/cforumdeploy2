export type OptimizedImageContentType = "image/jpeg" | "image/webp";

export interface OptimizedImageObject {
  blob: Blob;
  contentType: OptimizedImageContentType;
  bytes: number;
  checksumSha256: string;
  width: number;
  height: number;
}

export interface OptimizedImage {
  originalName: string;
  filename: string;
  alt: string;
  originalBytes: number;
  originalWidth: number;
  originalHeight: number;
  main: OptimizedImageObject;
  thumbnail: OptimizedImageObject;
}

export type ImageOptimizationErrorCode =
  | "UNSUPPORTED_TYPE"
  | "ORIGINAL_TOO_LARGE"
  | "DECODE_UNAVAILABLE"
  | "DECODE_FAILED"
  | "TOO_MANY_PIXELS"
  | "ENCODE_FAILED"
  | "OUTPUT_TOO_LARGE"
  | "CRYPTO_UNAVAILABLE";

export class ImageOptimizationError extends Error {
  readonly code: ImageOptimizationErrorCode;

  constructor(code: ImageOptimizationErrorCode) {
    super(code);
    this.name = "ImageOptimizationError";
    this.code = code;
  }
}

export const MAX_ORIGINAL_IMAGE_BYTES = 12 * 1024 * 1024;
export const MAX_DECODED_IMAGE_PIXELS = 24_000_000;
export const MAX_MAIN_IMAGE_BYTES = Math.floor(1.5 * 1024 * 1024);
export const MAX_THUMBNAIL_IMAGE_BYTES = 250 * 1024;
export const MAX_AVATAR_THUMBNAIL_BYTES = 128 * 1024;
export const MAX_AVATAR_EDGE = 256;

const ACCEPTED_INPUT_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAIN_MAX_EDGE = 2048;
const THUMBNAIL_MAX_EDGE = 640;
const MIN_ENCODE_EDGE = 160;

let webpSupportPromise: Promise<boolean> | null = null;

function canvasToBlob(
  canvas: HTMLCanvasElement,
  contentType: OptimizedImageContentType,
  quality: number,
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob || blob.type !== contentType) {
        reject(new ImageOptimizationError("ENCODE_FAILED"));
        return;
      }
      resolve(blob);
    }, contentType, quality);
  });
}

async function supportsWebpEncoding(): Promise<boolean> {
  if (webpSupportPromise) return webpSupportPromise;
  webpSupportPromise = new Promise((resolve) => {
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    canvas.toBlob(
      (blob) => resolve(blob?.type === "image/webp"),
      "image/webp",
      0.8,
    );
  });
  return webpSupportPromise;
}

function scaledDimensions(
  width: number,
  height: number,
  maxEdge: number,
): { width: number; height: number } {
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

function qualitySteps(initialQuality: number): number[] {
  return [initialQuality, 0.74, 0.66, 0.58, 0.5, 0.44]
    .filter((quality, index, values) => (
      quality <= initialQuality && values.indexOf(quality) === index
    ));
}

async function encodeVariant(
  bitmap: ImageBitmap,
  maxEdge: number,
  initialQuality: number,
  maxBytes: number,
  contentType: OptimizedImageContentType,
): Promise<Omit<OptimizedImageObject, "checksumSha256">> {
  let dimensions = scaledDimensions(bitmap.width, bitmap.height, maxEdge);

  for (let sizeAttempt = 0; sizeAttempt < 9; sizeAttempt += 1) {
    const canvas = document.createElement("canvas");
    canvas.width = dimensions.width;
    canvas.height = dimensions.height;
    const context = canvas.getContext("2d", { alpha: contentType !== "image/jpeg" });
    if (!context) throw new ImageOptimizationError("ENCODE_FAILED");
    if (contentType === "image/jpeg") {
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, dimensions.width, dimensions.height);
    }
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(bitmap, 0, 0, dimensions.width, dimensions.height);

    for (const quality of qualitySteps(initialQuality)) {
      const blob = await canvasToBlob(canvas, contentType, quality);
      if (blob.size <= maxBytes) {
        canvas.width = 1;
        canvas.height = 1;
        return {
          blob,
          contentType,
          bytes: blob.size,
          width: dimensions.width,
          height: dimensions.height,
        };
      }
    }

    canvas.width = 1;
    canvas.height = 1;
    if (Math.max(dimensions.width, dimensions.height) <= MIN_ENCODE_EDGE) break;
    dimensions = {
      width: Math.max(1, Math.round(dimensions.width * 0.82)),
      height: Math.max(1, Math.round(dimensions.height * 0.82)),
    };
  }

  throw new ImageOptimizationError("OUTPUT_TOO_LARGE");
}

export async function sha256Base64(blob: Blob): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    throw new ImageOptimizationError("CRYPTO_UNAVAILABLE");
  }
  const digest = await globalThis.crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  let binary = "";
  for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function isSafeFilenameCharacter(character: string): boolean {
  const codePoint = character.codePointAt(0) ?? 0;
  return codePoint > 0x1f && codePoint !== 0x7f && character !== "/" && character !== "\\";
}

function safeOutputFilename(originalName: string, extension: "webp" | "jpg"): string {
  const withoutExtension = originalName.replace(/\.[^.]+$/, "");
  const safeBase = [...withoutExtension]
    .filter(isSafeFilenameCharacter)
    .join("")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 180) || "forum-image";
  return `${safeBase}.${extension}`;
}

export function safeMarkdownAlt(value: string): string {
  const cleaned = [...value]
    .map((character) => (
      "[]\\()!\n\r\t".includes(character) ? " " : character
    ))
    .join("")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return cleaned || "主题图片";
}

export function describeImageOptimizationError(error: unknown): string {
  if (!(error instanceof ImageOptimizationError)) {
    return "无法处理这张图片，请换一张后重试。";
  }
  switch (error.code) {
    case "UNSUPPORTED_TYPE":
      return "仅支持 JPEG、PNG 或 WebP 图片。";
    case "ORIGINAL_TOO_LARGE":
      return "原图超过 12 MB，请先缩小文件。";
    case "DECODE_UNAVAILABLE":
      return "当前浏览器不支持安全图片解码，请升级浏览器后重试。";
    case "TOO_MANY_PIXELS":
      return "图片解码后超过 2400 万像素，请先缩小尺寸。";
    case "OUTPUT_TOO_LARGE":
      return "图片压缩后仍超过上传硬限制，请换一张更简单或更小的图片。";
    case "CRYPTO_UNAVAILABLE":
      return "当前页面无法使用 Web Crypto 校验图片，请确认使用安全连接。";
    case "DECODE_FAILED":
      return "图片无法解码，文件可能已损坏或格式与扩展名不符。";
    case "ENCODE_FAILED":
      return "浏览器无法重新编码这张图片，请换一张后重试。";
  }
}

async function optimizeImageWithThumbnail(
  file: File,
  thumbnailMaxEdge: number,
  thumbnailMaxBytes: number,
): Promise<OptimizedImage> {
  if (!ACCEPTED_INPUT_TYPES.has(file.type.toLowerCase())) {
    throw new ImageOptimizationError("UNSUPPORTED_TYPE");
  }
  if (file.size <= 0 || file.size > MAX_ORIGINAL_IMAGE_BYTES) {
    throw new ImageOptimizationError("ORIGINAL_TOO_LARGE");
  }
  if (typeof createImageBitmap !== "function") {
    throw new ImageOptimizationError("DECODE_UNAVAILABLE");
  }

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    throw new ImageOptimizationError("DECODE_FAILED");
  }

  try {
    if (
      bitmap.width <= 0 ||
      bitmap.height <= 0 ||
      bitmap.width * bitmap.height > MAX_DECODED_IMAGE_PIXELS
    ) {
      throw new ImageOptimizationError("TOO_MANY_PIXELS");
    }
    const contentType: OptimizedImageContentType = await supportsWebpEncoding()
      ? "image/webp"
      : "image/jpeg";
    const [mainWithoutChecksum, thumbnailWithoutChecksum] = await Promise.all([
      encodeVariant(bitmap, MAIN_MAX_EDGE, 0.82, MAX_MAIN_IMAGE_BYTES, contentType),
      encodeVariant(bitmap, thumbnailMaxEdge, 0.74, thumbnailMaxBytes, contentType),
    ]);
    const [mainChecksum, thumbnailChecksum] = await Promise.all([
      sha256Base64(mainWithoutChecksum.blob),
      sha256Base64(thumbnailWithoutChecksum.blob),
    ]);
    return {
      originalName: file.name,
      filename: safeOutputFilename(file.name, contentType === "image/webp" ? "webp" : "jpg"),
      alt: safeMarkdownAlt(file.name.replace(/\.[^.]+$/, "")),
      originalBytes: file.size,
      originalWidth: bitmap.width,
      originalHeight: bitmap.height,
      main: { ...mainWithoutChecksum, checksumSha256: mainChecksum },
      thumbnail: { ...thumbnailWithoutChecksum, checksumSha256: thumbnailChecksum },
    };
  } finally {
    bitmap.close();
  }
}

export function optimizeImage(file: File): Promise<OptimizedImage> {
  return optimizeImageWithThumbnail(
    file,
    THUMBNAIL_MAX_EDGE,
    MAX_THUMBNAIL_IMAGE_BYTES,
  );
}

export function optimizeAvatarImage(file: File): Promise<OptimizedImage> {
  return optimizeImageWithThumbnail(
    file,
    MAX_AVATAR_EDGE,
    MAX_AVATAR_THUMBNAIL_BYTES,
  );
}
