import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "@/worker/env";
import { topicVisibilityScope } from "@/worker/permissions/visibility-scope";
import { nowSeconds } from "@/worker/security/crypto";

const router = new Hono<AppEnv>();
const idSchema = z.string().min(1).max(80).regex(/^[A-Za-z0-9_-]+$/);

interface NotificationCursor {
  createdAt: number;
  id: string;
}

const cursorSchema = z.object({
  createdAt: z.number().int().nonnegative(),
  id: idSchema,
});

const listQuerySchema = z
  .object({ cursor: z.string().max(512).optional() })
  .strict();

export const readNotificationsSchema = z
  .object({
    ids: z.array(idSchema).min(1).max(100).optional(),
    all: z.literal(true).optional(),
  })
  .strict()
  .refine((value) => Boolean(value.ids) !== Boolean(value.all), {
    message: "ids 与 all 必须且只能提供一项",
  });

function decodeCursor(value: string | undefined): NotificationCursor | null {
  if (!value) return null;
  try {
    const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const parsed = cursorSchema.safeParse(JSON.parse(atob(padded)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function encodeCursor(cursor: NotificationCursor): string {
  return btoa(JSON.stringify(cursor))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function canReadNotifications(
  viewer: AppEnv["Variables"]["identity"]["viewer"],
): boolean {
  return (
    viewer.userId !== null &&
    (viewer.status === "active" || viewer.status === "silenced")
  );
}

const safeDataKeys = new Set([
  "action",
  "badgeSlug",
  "deadlineAt",
  "fromLevel",
  "reason",
  "reviewItemId",
  "toLevel",
  "type",
]);

function safeNotificationData(value: string): Record<string, string | number | boolean> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const safe: Record<string, string | number | boolean> = {};
    for (const [key, item] of Object.entries(parsed)) {
      if (
        safeDataKeys.has(key) &&
        (typeof item === "string" ||
          typeof item === "number" ||
          typeof item === "boolean")
      ) {
        safe[key] = item;
      }
    }
    return safe;
  } catch {
    return {};
  }
}

interface NotificationRow {
  id: string;
  kind: string;
  topic_id: string | null;
  post_id: string | null;
  data_json: string;
  created_at: number;
  read_at: number | null;
  actor_id: string | null;
  actor_username: string | null;
  actor_display_name: string | null;
  target_accessible: number;
}

router.get("/notifications", async (context) => {
  const viewer = context.get("identity").viewer;
  if (!viewer.userId) {
    return context.json({ error: { code: "AUTHENTICATION_REQUIRED" } }, 401);
  }
  if (!canReadNotifications(viewer)) {
    return context.json({ error: { code: "ACTION_NOT_ALLOWED" } }, 403);
  }
  const parsed = listQuerySchema.safeParse(context.req.query());
  if (!parsed.success) {
    return context.json({ error: { code: "INVALID_QUERY" } }, 422);
  }
  const cursor = decodeCursor(parsed.data.cursor);
  if (parsed.data.cursor && !cursor) {
    return context.json({ error: { code: "INVALID_CURSOR" } }, 422);
  }

  const scope = topicVisibilityScope(viewer);
  const where = ["n.user_id = ?"];
  const bindings: Array<string | number | null> = [
    ...scope.bindings,
    viewer.userId,
    viewer.userId,
  ];
  if (cursor) {
    where.push("(n.created_at < ? OR (n.created_at = ? AND n.id < ?))");
    bindings.push(cursor.createdAt, cursor.createdAt, cursor.id);
  }
  bindings.push(21);

  const result = await context.env.CFORUM_DB.prepare(
    `SELECT
       n.id, n.kind, n.topic_id, n.post_id, n.data_json, n.created_at,
       n.read_at, actor.id AS actor_id, actor.username AS actor_username,
       actor.display_name AS actor_display_name,
       CASE
         WHEN n.topic_id IS NULL THEN 1
         WHEN ${scope.clause}
          AND (
            n.post_id IS NULL
            OR p.status = 'published'
            OR (p.status = 'pending' AND p.author_id = ?)
          ) THEN 1
         ELSE 0
       END AS target_accessible
     FROM notifications n
     LEFT JOIN users actor ON actor.id = n.actor_user_id
     LEFT JOIN topics t ON t.id = n.topic_id
     LEFT JOIN categories c ON c.id = t.category_id
     LEFT JOIN posts p ON p.id = n.post_id AND p.topic_id = n.topic_id
     WHERE ${where.join(" AND ")}
     ORDER BY n.created_at DESC, n.id DESC
     LIMIT ?`,
  )
    .bind(...bindings)
    .all<NotificationRow>();
  const hasMore = result.results.length > 20;
  const rows = result.results.slice(0, 20);
  const last = rows.at(-1);
  const unread = await context.env.CFORUM_DB.prepare(
    "SELECT COUNT(*) AS count FROM notifications WHERE user_id = ?1 AND read_at IS NULL",
  )
    .bind(viewer.userId)
    .first<{ count: number }>();

  return context.json({
    notifications: rows.map((row) => {
      const targetAccessible = row.target_accessible === 1;
      return {
        id: row.id,
        kind: row.kind,
        actor:
          row.actor_id && row.actor_username && row.actor_display_name
            ? {
                id: row.actor_id,
                username: row.actor_username,
                displayName: row.actor_display_name,
              }
            : null,
        topicId: targetAccessible ? row.topic_id : null,
        postId: targetAccessible ? row.post_id : null,
        targetAvailable: targetAccessible,
        data: safeNotificationData(row.data_json),
        createdAt: new Date(row.created_at * 1_000).toISOString(),
        readAt:
          row.read_at === null
            ? null
            : new Date(row.read_at * 1_000).toISOString(),
      };
    }),
    unreadCount: Number(unread?.count ?? 0),
    nextCursor:
      hasMore && last
        ? encodeCursor({ createdAt: last.created_at, id: last.id })
        : null,
  });
});

router.post("/notifications/read", async (context) => {
  const viewer = context.get("identity").viewer;
  if (!viewer.userId) {
    return context.json({ error: { code: "AUTHENTICATION_REQUIRED" } }, 401);
  }
  if (!canReadNotifications(viewer)) {
    return context.json({ error: { code: "ACTION_NOT_ALLOWED" } }, 403);
  }
  const parsed = readNotificationsSchema.safeParse(
    await context.req.json().catch(() => null),
  );
  if (!parsed.success) {
    return context.json({ error: { code: "INVALID_INPUT" } }, 422);
  }

  const now = nowSeconds();
  const statement = parsed.data.all
    ? context.env.CFORUM_DB.prepare(
        `UPDATE notifications SET read_at = ?1
         WHERE user_id = ?2 AND read_at IS NULL AND created_at <= ?1`,
      ).bind(now, viewer.userId)
    : context.env.CFORUM_DB.prepare(
        `UPDATE notifications SET read_at = ?1
         WHERE user_id = ?2 AND read_at IS NULL
           AND id IN (${parsed.data.ids?.map(() => "?").join(", ")})`,
      ).bind(now, viewer.userId, ...(parsed.data.ids ?? []));
  const result = await statement.run();
  const unread = await context.env.CFORUM_DB.prepare(
    "SELECT COUNT(*) AS count FROM notifications WHERE user_id = ?1 AND read_at IS NULL",
  )
    .bind(viewer.userId)
    .first<{ count: number }>();

  return context.json({
    updated: Number(result.meta.changes ?? 0),
    unreadCount: Number(unread?.count ?? 0),
  });
});

export default router;
