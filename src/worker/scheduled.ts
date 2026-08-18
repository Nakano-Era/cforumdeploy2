import type { Bindings } from "@/worker/env";
import { cleanupStaleMedia } from "@/worker/media/cleanup";
import { runTrustLevelReview } from "@/worker/trust/engine";

export const TRUST_REVIEW_CRON = "*/15 * * * *";
export const MEDIA_CLEANUP_CRON = "7 * * * *";
const MEDIA_CLEANUP_MAX_PASSES = 4;

async function runMediaCleanup(
  env: Bindings,
  scheduledTime: number,
): Promise<void> {
  let failed = 0;
  let hasMore = false;
  for (let pass = 0; pass < MEDIA_CLEANUP_MAX_PASSES; pass += 1) {
    const result = await cleanupStaleMedia(env, new Date(scheduledTime));
    failed += result.failed;
    hasMore = result.hasMore;
    if (!hasMore) break;
  }
  if (failed > 0) throw new Error("media_cleanup_incomplete");
  if (hasMore) console.warn("media_cleanup_backlog");
}

export async function handleScheduled(
  controller: ScheduledController,
  env: Bindings,
): Promise<void> {
  const now = Math.floor(controller.scheduledTime / 1_000);
  if (controller.cron === TRUST_REVIEW_CRON) {
    await runTrustLevelReview(env, { now });
    return;
  }
  if (controller.cron === MEDIA_CLEANUP_CRON) {
    await runMediaCleanup(env, controller.scheduledTime);
    return;
  }
  await env.CFORUM_DB.batch([
    env.CFORUM_DB.prepare(
      "DELETE FROM sessions WHERE expires_at < ?1 OR revoked_at < ?2",
    ).bind(now, now - 7 * 24 * 60 * 60),
    env.CFORUM_DB.prepare(
      `DELETE FROM email_verifications
       WHERE expires_at < ?1 AND status != 'verified'`,
    ).bind(now - 24 * 60 * 60),
    env.CFORUM_DB.prepare(
      "DELETE FROM rate_limit_buckets WHERE expires_at < ?1",
    ).bind(now),
    env.CFORUM_DB.prepare(
      "DELETE FROM webauthn_challenges WHERE expires_at < ?1",
    ).bind(now - 24 * 60 * 60),
    env.CFORUM_DB.prepare(
      `UPDATE upload_reservations
       SET status = 'expired'
      WHERE status = 'active' AND expires_at < ?1`,
    ).bind(now),
  ]);
}
