import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "@/worker/env";
import { evaluateViewTopic } from "@/worker/permissions/policy";
import { getTopicAggregate } from "@/worker/repositories/forum";
import { hmacSha256, nowSeconds } from "@/worker/security/crypto";
import { recordReadingHeartbeat } from "@/worker/trust/activity";

export const readingHeartbeatSchema = z
  .object({
    topicId: z.string().min(1).max(80).regex(/^[A-Za-z0-9_-]+$/),
    seconds: z.number().int().min(5).max(60),
  })
  .strict();

const router = new Hono<AppEnv>();

router.post("/activity/reading-heartbeat", async (context) => {
  const identity = context.get("identity");
  if (!identity.session || !identity.viewer.userId) {
    return context.json({ error: { code: "AUTHENTICATION_REQUIRED" } }, 401);
  }
  if (identity.viewer.status !== "active") {
    return context.json({ error: { code: "ACCOUNT_NOT_ACTIVE" } }, 403);
  }

  const parsed = readingHeartbeatSchema.safeParse(
    await context.req.json().catch(() => null),
  );
  if (!parsed.success) {
    return context.json({ error: { code: "INVALID_INPUT" } }, 422);
  }

  const aggregate = await getTopicAggregate(
    context.env.CFORUM_DB,
    parsed.data.topicId,
  );
  if (
    !aggregate ||
    !evaluateViewTopic(
      identity.viewer,
      aggregate.category,
      aggregate.topic,
    ).allowed
  ) {
    return context.json({ error: { code: "NOT_FOUND" } }, 404);
  }

  const result = await recordReadingHeartbeat(context.env.CFORUM_DB, {
    userId: identity.viewer.userId,
    topicId: parsed.data.topicId,
    rateKeyHash: await hmacSha256(
      context.env.SESSION_HMAC_SECRET,
      `reading-heartbeat:${identity.viewer.userId}`,
    ),
    seconds: parsed.data.seconds,
    now: nowSeconds(),
  });
  return context.json({
    activity: {
      credited: result.accepted,
      readingSecondsToday: result.readingSecondsToday,
    },
  });
});

export default router;
