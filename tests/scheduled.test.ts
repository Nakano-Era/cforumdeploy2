import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Bindings } from "@/worker/env";

const { cleanupMock, trustReviewMock } = vi.hoisted(() => ({
  cleanupMock: vi.fn(),
  trustReviewMock: vi.fn(),
}));

vi.mock("@/worker/media/cleanup", () => ({
  cleanupStaleMedia: cleanupMock,
}));
vi.mock("@/worker/trust/engine", () => ({
  runTrustLevelReview: trustReviewMock,
}));

import {
  handleScheduled,
  MEDIA_CLEANUP_CRON,
  TRUST_REVIEW_CRON,
} from "@/worker/scheduled";

const scheduledTime = Date.UTC(2026, 7, 16, 2, 17);

function controller(cron: string): ScheduledController {
  return { cron, scheduledTime } as ScheduledController;
}

function environment() {
  const statement = {
    bind: vi.fn(() => statement),
  };
  const batch = vi.fn(async () => [] as D1Result[]);
  return {
    env: {
      CFORUM_DB: {
        prepare: vi.fn(() => statement),
        batch,
      } as unknown as D1Database,
    } as Bindings,
    batch,
  };
}

function cleanupResult(overrides: Partial<{
  failed: number;
  hasMore: boolean;
}> = {}) {
  return {
    examined: 0,
    deleted: 0,
    quarantined: 0,
    failed: overrides.failed ?? 0,
    orphanObjectsExamined: 0,
    orphanObjectsDeleted: 0,
    hasMore: overrides.hasMore ?? false,
  };
}

describe("scheduled dispatch", () => {
  beforeEach(() => {
    cleanupMock.mockReset();
    trustReviewMock.mockReset();
  });

  it("routes the trust cron without running unrelated maintenance", async () => {
    const { env, batch } = environment();
    await handleScheduled(controller(TRUST_REVIEW_CRON), env);

    expect(trustReviewMock).toHaveBeenCalledWith(env, {
      now: Math.floor(scheduledTime / 1_000),
    });
    expect(cleanupMock).not.toHaveBeenCalled();
    expect(batch).not.toHaveBeenCalled();
  });

  it("drains at most four bounded media pages per hourly invocation", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    cleanupMock
      .mockResolvedValueOnce(cleanupResult({ hasMore: true }))
      .mockResolvedValueOnce(cleanupResult({ hasMore: true }))
      .mockResolvedValueOnce(cleanupResult({ hasMore: true }))
      .mockResolvedValueOnce(cleanupResult({ hasMore: true }));
    const { env, batch } = environment();

    await handleScheduled(controller(MEDIA_CLEANUP_CRON), env);

    expect(cleanupMock).toHaveBeenCalledTimes(4);
    expect(cleanupMock).toHaveBeenCalledWith(env, new Date(scheduledTime));
    expect(batch).not.toHaveBeenCalled();
    expect(warning).toHaveBeenCalledWith("media_cleanup_backlog");
    warning.mockRestore();
  });

  it("fails the media cron when a bounded pass reports an error", async () => {
    cleanupMock.mockResolvedValue(
      cleanupResult({ failed: 1, hasMore: false }),
    );
    const { env } = environment();

    await expect(
      handleScheduled(controller(MEDIA_CLEANUP_CRON), env),
    ).rejects.toThrow("media_cleanup_incomplete");
  });

  it("keeps daily database maintenance separate from media cleanup", async () => {
    const { env, batch } = environment();
    await handleScheduled(controller("17 2 * * *"), env);

    expect(batch).toHaveBeenCalledTimes(1);
    expect(cleanupMock).not.toHaveBeenCalled();
    expect(trustReviewMock).not.toHaveBeenCalled();
  });
});
