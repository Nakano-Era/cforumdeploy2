import { describe, expect, it } from "vitest";
import { MEBIBYTE, dailyUploadLimitBytes } from "@/worker/media/constants";
import { evaluateMediaQuota } from "@/worker/media/quota";

const GIBIBYTE = 1024 * MEBIBYTE;

function snapshot(overrides: Record<string, number> = {}) {
  return {
    dailyUsedBytes: 0,
    activeUserReservedBytes: 0,
    storedBytes: 0,
    activeSiteReservedBytes: 0,
    softLimitBytes: 7 * GIBIBYTE,
    hardLimitBytes: 8 * GIBIBYTE,
    ...overrides,
  };
}

describe("media quota policy", () => {
  it.each([
    [0, 5],
    [1, 15],
    [2, 30],
    [3, 50],
    [4, 50],
  ] as const)("sets Lv%s to %s MiB per UTC day", (level, mebibytes) => {
    expect(dailyUploadLimitBytes(level)).toBe(mebibytes * MEBIBYTE);
  });

  it("counts finalized daily bytes and active reservations together", () => {
    const decision = evaluateMediaQuota(
      0,
      2 * MEBIBYTE,
      snapshot({
        dailyUsedBytes: 2 * MEBIBYTE,
        activeUserReservedBytes: 2 * MEBIBYTE,
      }),
    );
    expect(decision).toMatchObject({ allowed: false, reason: "daily_limit" });
  });

  it("allows an exact daily-limit boundary", () => {
    expect(
      evaluateMediaQuota(
        1,
        5 * MEBIBYTE,
        snapshot({
          dailyUsedBytes: 7 * MEBIBYTE,
          activeUserReservedBytes: 3 * MEBIBYTE,
        }),
      ),
    ).toMatchObject({ allowed: true, dailyRemainingBytes: 0 });
  });

  it("counts every active site reservation against the 8 GiB hard gate", () => {
    const decision = evaluateMediaQuota(
      4,
      2 * MEBIBYTE,
      snapshot({
        storedBytes: 8 * GIBIBYTE - 3 * MEBIBYTE,
        activeSiteReservedBytes: 2 * MEBIBYTE,
      }),
    );
    expect(decision).toMatchObject({
      allowed: false,
      reason: "site_hard_limit",
    });
  });

  it("allows an exact hard-limit boundary but never one byte more", () => {
    const atBoundary = snapshot({ storedBytes: 8 * GIBIBYTE - MEBIBYTE });
    expect(evaluateMediaQuota(4, MEBIBYTE, atBoundary).allowed).toBe(true);
    expect(evaluateMediaQuota(4, MEBIBYTE + 1, atBoundary)).toMatchObject({
      allowed: false,
      reason: "site_hard_limit",
    });
  });

  it("halves the per-user daily allowance after the 7 GiB soft limit", () => {
    const atSoftLimit = snapshot({ storedBytes: 7 * GIBIBYTE });
    expect(evaluateMediaQuota(2, 15 * MEBIBYTE, atSoftLimit)).toMatchObject({
      allowed: true,
      dailyLimitBytes: 15 * MEBIBYTE,
      capacityWarning: true,
    });
    expect(evaluateMediaQuota(2, 15 * MEBIBYTE + 1, atSoftLimit)).toMatchObject({
      allowed: false,
      reason: "daily_limit",
    });
  });

  it("warns when a reservation will cross the soft limit", () => {
    expect(
      evaluateMediaQuota(
        4,
        2 * MEBIBYTE,
        snapshot({ storedBytes: 7 * GIBIBYTE - MEBIBYTE }),
      ),
    ).toMatchObject({ allowed: true, capacityWarning: true });
  });
});
