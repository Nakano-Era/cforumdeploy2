import { describe, expect, it } from "vitest";
import { PRESIGNED_PUT_TTL_SECONDS } from "@/worker/media/constants";
import { presignR2Put } from "@/worker/media/presign";

const checksum = btoa(String.fromCharCode(...new Uint8Array(32).fill(23)));

describe("R2 presigned PUT", () => {
  it("uses aws4fetch and signs content type plus SHA-256 for exactly five minutes", async () => {
    const result = await presignR2Put(
      {
        accountId: "0123456789abcdef",
        bucketName: "private-media",
        accessKeyId: "access-key-id",
        secretAccessKey: "super-secret-signing-key",
      },
      "tmp/user-1/31cf6a28-8d72-4b8e-a4e5-75328ef04c57.webp",
      "image/webp",
      checksum,
      new Date("2026-08-16T08:00:00.000Z"),
    );
    const url = new URL(result.url);
    const signedHeaders = url.searchParams.get("X-Amz-SignedHeaders") ?? "";

    expect(result.method).toBe("PUT");
    expect(result.expiresInSeconds).toBe(PRESIGNED_PUT_TTL_SECONDS);
    expect(result.headers).toEqual({
      "content-type": "image/webp",
      "x-amz-checksum-sha256": checksum,
    });
    expect(url.protocol).toBe("https:");
    expect(url.hostname).toBe(
      "0123456789abcdef.r2.cloudflarestorage.com",
    );
    expect(url.pathname).toContain("/private-media/tmp/user-1/");
    expect(url.searchParams.get("X-Amz-Expires")).toBe("300");
    expect(url.searchParams.get("X-Amz-Algorithm")).toBe(
      "AWS4-HMAC-SHA256",
    );
    expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[a-f0-9]{64}$/);
    expect(signedHeaders.split(";")).toEqual(
      expect.arrayContaining([
        "content-type",
        "host",
        "x-amz-checksum-sha256",
      ]),
    );
    expect(result.url).not.toContain("super-secret-signing-key");
  });

  it("produces a different signature when a signed checksum changes", async () => {
    const config = {
      accountId: "0123456789abcdef",
      bucketName: "private-media",
      accessKeyId: "access-key-id",
      secretAccessKey: "super-secret-signing-key",
    };
    const now = new Date("2026-08-16T08:00:00.000Z");
    const first = new URL(
      (
        await presignR2Put(
          config,
          "tmp/user-1/object.webp",
          "image/webp",
          checksum,
          now,
        )
      ).url,
    );
    const otherChecksum = btoa(
      String.fromCharCode(...new Uint8Array(32).fill(24)),
    );
    const second = new URL(
      (
        await presignR2Put(
          config,
          "tmp/user-1/object.webp",
          "image/webp",
          otherChecksum,
          now,
        )
      ).url,
    );

    expect(first.searchParams.get("X-Amz-Signature")).not.toBe(
      second.searchParams.get("X-Amz-Signature"),
    );
  });
});
