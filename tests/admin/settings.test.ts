import { describe, expect, it } from "vitest";
import { adminSettingsSchema } from "@/worker/routes/admin";

describe("admin settings schema", () => {
  it("allows administrators to disable either Lv0 review threshold", () => {
    const parsed = adminSettingsSchema.safeParse({
      lv0FirstTopicsReviewCount: 0,
      lv0FirstRepliesReviewCount: 0,
    });

    expect(parsed.success).toBe(true);
  });

  it("accepts the three mutually exclusive registration modes", () => {
    for (const registrationMode of ["open", "approval", "invite_only"] as const) {
      expect(adminSettingsSchema.safeParse({ registrationMode }).success).toBe(
        true,
      );
    }
  });

  it("rejects empty, unknown, and excessive review settings", () => {
    expect(adminSettingsSchema.safeParse({}).success).toBe(false);
    expect(adminSettingsSchema.safeParse({ arbitrary: true }).success).toBe(false);
    expect(
      adminSettingsSchema.safeParse({ lv0FirstTopicsReviewCount: 21 }).success,
    ).toBe(false);
  });
});
