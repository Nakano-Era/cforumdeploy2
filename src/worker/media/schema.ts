import { z } from "zod";
import {
  MAX_BATCH_BYTES,
  MAX_IMAGE_DIMENSION,
  MAX_MAIN_BYTES,
  MAX_THUMBNAIL_BYTES,
  MAX_UPLOADS_PER_BATCH,
  SUPPORTED_IMAGE_MIME_TYPES,
} from "@/worker/media/constants";

const sha256Base64Schema = z
  .string()
  .regex(/^[A-Za-z0-9+/]{43}=$/, "checksum 必须是标准 Base64 SHA-256");

function isSafeFilename(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (
      codePoint <= 0x1f ||
      codePoint === 0x7f ||
      character === "/" ||
      character === "\\"
    ) {
      return false;
    }
  }
  return true;
}

const filenameSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .refine(
    isSafeFilename,
    "文件名包含不安全字符",
  );

const dimensionSchema = z.number().int().min(1).max(MAX_IMAGE_DIMENSION);

function imageObjectSchema(maxBytes: number) {
  return z
    .object({
      contentType: z.enum(SUPPORTED_IMAGE_MIME_TYPES),
      bytes: z.number().int().min(1).max(maxBytes),
      checksumSha256: sha256Base64Schema,
      width: dimensionSchema,
      height: dimensionSchema,
    })
    .strict();
}

export const mainImageSchema = imageObjectSchema(MAX_MAIN_BYTES);
export const thumbnailImageSchema = imageObjectSchema(MAX_THUMBNAIL_BYTES);

export const authorizeUploadsSchema = z
  .object({
    uploads: z
      .array(
        z
          .object({
            filename: filenameSchema,
            main: mainImageSchema,
            thumbnail: thumbnailImageSchema.optional(),
          })
          .strict(),
      )
      .min(1)
      .max(MAX_UPLOADS_PER_BATCH),
  })
  .strict()
  .superRefine((value, context) => {
    const totalBytes = value.uploads.reduce(
      (sum, upload) =>
        sum + upload.main.bytes + (upload.thumbnail?.bytes ?? 0),
      0,
    );
    if (totalBytes > MAX_BATCH_BYTES) {
      context.addIssue({
        code: "custom",
        message: "批次总字节数超出限制",
        path: ["uploads"],
      });
    }
  });

export const finalizeUploadsSchema = z
  .object({ reservationId: z.string().uuid() })
  .strict();

export const uploadIdSchema = z.string().uuid();

export const bindUploadSchema = z
  .object({
    uploadId: uploadIdSchema,
    topicId: z.string().uuid(),
    postId: z.string().uuid(),
  })
  .strict();

export const bindAvatarSchema = z
  .object({ uploadId: uploadIdSchema })
  .strict();

export const mediaVariantSchema = z.enum(["main", "thumbnail"]);

export type AuthorizeUploadsInput = z.infer<typeof authorizeUploadsSchema>;
export type ImageObjectInput = z.infer<typeof mainImageSchema>;
export type FinalizeUploadsInput = z.infer<typeof finalizeUploadsSchema>;
export type BindUploadInput = z.infer<typeof bindUploadSchema>;
export type MediaVariant = z.infer<typeof mediaVariantSchema>;

export function countObjects(input: AuthorizeUploadsInput): number {
  return input.uploads.reduce(
    (sum, upload) => sum + 1 + (upload.thumbnail ? 1 : 0),
    0,
  );
}

export function countBytes(input: AuthorizeUploadsInput): number {
  return input.uploads.reduce(
    (sum, upload) =>
      sum + upload.main.bytes + (upload.thumbnail?.bytes ?? 0),
    0,
  );
}
