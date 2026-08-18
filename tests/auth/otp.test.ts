import { describe, expect, it } from "vitest";
import {
  generateOtpCode,
  hashOtpCode,
  hashVerificationTicket,
  normalizeEmail,
} from "@/worker/auth/otp";

describe("email OTP primitives", () => {
  it("normalizes case, surrounding space, and compatibility characters", () => {
    expect(normalizeEmail("  ＵＳＥＲ＠Example.COM  ")).toBe(
      "user@example.com",
    );
  });

  it("generates an unbiased, zero-padded eight digit code", () => {
    const values = [0xffff_ffff, 42];
    expect(generateOtpCode(() => values.shift() ?? 0)).toBe("00000042");
    expect(generateOtpCode(() => 99_999_999)).toBe("99999999");
  });

  it("binds OTP and ticket hashes to their challenge and email", async () => {
    const secret = "s".repeat(32);
    const base = await hashOtpCode(
      secret,
      "challenge-a",
      "user@example.com",
      "12345678",
    );
    expect(
      await hashOtpCode(
        secret,
        "challenge-a",
        "USER@example.com",
        "12345678",
      ),
    ).toBe(base);
    expect(
      await hashOtpCode(
        secret,
        "challenge-b",
        "user@example.com",
        "12345678",
      ),
    ).not.toBe(base);
    expect(
      await hashVerificationTicket(
        secret,
        "challenge-a",
        "user@example.com",
        "12345678",
      ),
    ).not.toBe(base);
  });
});
