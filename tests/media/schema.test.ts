import { describe, expect, it } from "vitest";
import {
  MAX_BATCH_BYTES,
  MAX_MAIN_BYTES,
  MAX_THUMBNAIL_BYTES,
  MAX_UPLOADS_PER_BATCH,
} from "@/worker/media/constants";
import {
  authorizeUploadsSchema,
  bindUploadSchema,
  countBytes,
  countObjects,
} from "@/worker/media/schema";

const checksum = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));

function main(overrides: Record<string, unknown> = {}) {
  return {
    contentType: "image/webp",
    bytes: 320_000,
    checksumSha256: checksum,
    width: 1920,
    height: 1080,
    ...overrides,
  };
}

function thumbnail(overrides: Record<string, unknown> = {}) {
  return {
    contentType: "image/webp",
    bytes: 60_000,
    checksumSha256: checksum,
    width: 640,
    height: 360,
    ...overrides,
  };
}

describe("upload authorization input", () => {
  it.each(["image/jpeg", "image/png", "image/webp"] as const)(
    "accepts a bounded %s main image and thumbnail",
    (contentType) => {
      const parsed = authorizeUploadsSchema.parse({
        uploads: [
          {
            filename: "论坛图片 01.png",
            main: main({ contentType }),
            thumbnail: thumbnail({ contentType }),
          },
        ],
      });

      expect(countObjects(parsed)).toBe(2);
      expect(countBytes(parsed)).toBe(380_000);
    },
  );

  it.each([
    { field: "SVG MIME", value: main({ contentType: "image/svg+xml" }) },
    { field: "oversized main", value: main({ bytes: MAX_MAIN_BYTES + 1 }) },
    { field: "zero bytes", value: main({ bytes: 0 }) },
    { field: "bad checksum", value: main({ checksumSha256: "not-a-digest" }) },
    { field: "unsafe filename", value: main() },
  ])("rejects $field", ({ field, value }) => {
    const filename = field === "unsafe filename" ? "../payload.webp" : "safe.webp";
    expect(
      authorizeUploadsSchema.safeParse({
        uploads: [{ filename, main: value }],
      }).success,
    ).toBe(false);
  });

  it("rejects an oversized thumbnail independently from the main image", () => {
    expect(
      authorizeUploadsSchema.safeParse({
        uploads: [
          {
            filename: "safe.webp",
            main: main(),
            thumbnail: thumbnail({ bytes: MAX_THUMBNAIL_BYTES + 1 }),
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("rejects too many logical images", () => {
    expect(
      authorizeUploadsSchema.safeParse({
        uploads: Array.from({ length: MAX_UPLOADS_PER_BATCH + 1 }, (_, index) => ({
          filename: `${index}.webp`,
          main: main(),
        })),
      }).success,
    ).toBe(false);
  });

  it("rejects a batch whose aggregate bytes exceed the batch hard limit", () => {
    const uploads = Array.from({ length: MAX_UPLOADS_PER_BATCH }, (_, index) => ({
      filename: `${index}.webp`,
      main: main({ bytes: MAX_MAIN_BYTES }),
      thumbnail: thumbnail({ bytes: MAX_THUMBNAIL_BYTES }),
    }));
    const total = uploads.reduce(
      (sum, upload) => sum + upload.main.bytes + upload.thumbnail.bytes,
      0,
    );
    expect(total).toBeGreaterThan(MAX_BATCH_BYTES);
    expect(authorizeUploadsSchema.safeParse({ uploads }).success).toBe(false);
  });

  it("rejects unknown fields instead of silently accepting client metadata", () => {
    expect(
      authorizeUploadsSchema.safeParse({
        uploads: [
          {
            filename: "safe.webp",
            main: { ...main(), objectKey: "chosen/by/client" },
          },
        ],
      }).success,
    ).toBe(false);
  });
});

describe("upload binding input", () => {
  const valid = {
    uploadId: "11111111-1111-4111-8111-111111111111",
    topicId: "22222222-2222-4222-8222-222222222222",
    postId: "33333333-3333-4333-8333-333333333333",
  };

  it("requires three UUIDs and rejects client-selected object metadata", () => {
    expect(bindUploadSchema.safeParse(valid).success).toBe(true);
    expect(
      bindUploadSchema.safeParse({ ...valid, objectKey: "public/chosen.png" })
        .success,
    ).toBe(false);
    expect(bindUploadSchema.safeParse({ ...valid, postId: "../post" }).success).toBe(
      false,
    );
  });
});
