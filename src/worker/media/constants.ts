import type { TrustLevel } from "@/shared/domain";

export const MEBIBYTE = 1024 * 1024;

export const PRESIGNED_PUT_TTL_SECONDS = 5 * 60;
export const MAX_UPLOADS_PER_BATCH = 10;
export const MAX_OBJECTS_PER_BATCH = MAX_UPLOADS_PER_BATCH * 2;
export const MAX_BATCH_BYTES = 16 * MEBIBYTE;
export const MAX_MAIN_BYTES = Math.floor(1.5 * MEBIBYTE);
export const MAX_THUMBNAIL_BYTES = 250 * 1024;
export const MAX_AVATAR_THUMBNAIL_BYTES = 128 * 1024;
export const MAX_AVATAR_EDGE = 256;
export const MAX_HEADER_BYTES = 64 * 1024;
export const MAX_IMAGE_PIXELS = 24_000_000;
export const MAX_IMAGE_DIMENSION = 16_384;

export const DEFAULT_R2_SOFT_LIMIT_BYTES = 7 * 1024 * MEBIBYTE;
export const DEFAULT_R2_HARD_LIMIT_BYTES = 8 * 1024 * MEBIBYTE;

export const MEDIA_DAILY_USAGE_RESOURCE = "media_upload_bytes";
export const R2_STORAGE_USAGE_RESOURCE = "r2_storage_bytes";
export const R2_STORAGE_PERIOD_KEY = "lifetime";
export const R2_STORAGE_COUNTER_KEY = "total";

const DAILY_UPLOAD_LIMITS: Record<TrustLevel, number> = {
  0: 5 * MEBIBYTE,
  1: 15 * MEBIBYTE,
  2: 30 * MEBIBYTE,
  3: 50 * MEBIBYTE,
  4: 50 * MEBIBYTE,
};

export function dailyUploadLimitBytes(trustLevel: TrustLevel): number {
  return DAILY_UPLOAD_LIMITS[trustLevel];
}

export const SUPPORTED_IMAGE_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;

export type SupportedImageMimeType =
  (typeof SUPPORTED_IMAGE_MIME_TYPES)[number];

export function extensionForMimeType(mimeType: SupportedImageMimeType): string {
  switch (mimeType) {
    case "image/jpeg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
  }
}
