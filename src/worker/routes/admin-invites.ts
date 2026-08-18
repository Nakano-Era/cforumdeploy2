import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "@/worker/env";
import { hashInviteToken } from "@/worker/routes/auth";
import {
  nowSeconds,
  randomToken,
} from "@/worker/security/crypto";

const router = new Hono<AppEnv>();

const idSchema = z.string().min(1).max(80).regex(/^[A-Za-z0-9_-]+$/);

export const createInviteSchema = z
  .object({
    maxUses: z.literal(1),
  })
  .strict();

export const revokeInviteSchema = z
  .object({
    revoked: z.literal(true),
  })
  .strict();

export const inviteListQuerySchema = z
  .object({
    cursor: z.string().max(512).optional(),
  })
  .strict();

interface InviteCursor {
  createdAt: number;
  id: string;
}

const inviteCursorSchema = z.object({
  createdAt: z.number().int().nonnegative(),
  id: idSchema,
});

interface InviteRow {
  id: string;
  max_uses: number;
  used_count: number;
  expires_at: number | null;
  revoked_at: number | null;
  created_at: number;
  created_by_id: string;
  created_by_username: string;
  created_by_display_name: string;
}

function activeAdmin(context: {
  get(key: "identity"): AppEnv["Variables"]["identity"];
}): { userId: string } | null {
  const identity = context.get("identity");
  if (
    !identity.session ||
    !identity.viewer.userId ||
    identity.viewer.role !== "admin" ||
    identity.viewer.status !== "active"
  ) {
    return null;
  }
  return { userId: identity.viewer.userId };
}

function encodeCursor(cursor: InviteCursor): string {
  return btoa(JSON.stringify(cursor))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function decodeCursor(value: string | undefined): InviteCursor | null {
  if (!value) return null;
  try {
    const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const parsed = inviteCursorSchema.safeParse(JSON.parse(atob(padded)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function isoFromSeconds(value: number | null): string | null {
  return value === null ? null : new Date(value * 1_000).toISOString();
}

function invitationStatus(
  row: Pick<InviteRow, "revoked_at" | "used_count" | "max_uses" | "expires_at">,
  now: number,
): "active" | "revoked" | "exhausted" | "expired" {
  if (row.revoked_at !== null) return "revoked";
  if (row.used_count >= row.max_uses) return "exhausted";
  if (row.expires_at !== null && row.expires_at <= now) return "expired";
  return "active";
}

function serializeInvite(row: InviteRow, now: number) {
  return {
    id: row.id,
    status: invitationStatus(row, now),
    maxUses: row.max_uses,
    usedCount: row.used_count,
    createdAt: isoFromSeconds(row.created_at),
    expiresAt: isoFromSeconds(row.expires_at),
    revokedAt: isoFromSeconds(row.revoked_at),
    createdBy: {
      id: row.created_by_id,
      username: row.created_by_username,
      displayName: row.created_by_display_name,
    },
  };
}

function selectInviteById(database: D1Database, id: string) {
  return database
    .prepare(
      `SELECT
         i.id, i.max_uses, i.used_count, i.expires_at, i.revoked_at,
         i.created_at, creator.id AS created_by_id,
         creator.username AS created_by_username,
         creator.display_name AS created_by_display_name
       FROM invites i
       JOIN users creator ON creator.id = i.created_by
       WHERE i.id = ?1
       LIMIT 1`,
    )
    .bind(id)
    .first<InviteRow>();
}

router.get("/admin/invites", async (context) => {
  const identity = context.get("identity");
  if (!identity.session || !identity.viewer.userId) {
    return context.json({ error: { code: "AUTHENTICATION_REQUIRED" } }, 401);
  }
  if (!activeAdmin(context)) {
    return context.json({ error: { code: "ACTION_NOT_ALLOWED" } }, 403);
  }

  const parsed = inviteListQuerySchema.safeParse(context.req.query());
  if (!parsed.success) {
    return context.json({ error: { code: "INVALID_QUERY" } }, 422);
  }
  const cursor = decodeCursor(parsed.data.cursor);
  if (parsed.data.cursor && !cursor) {
    return context.json({ error: { code: "INVALID_CURSOR" } }, 422);
  }

  const where: string[] = [];
  const bindings: Array<string | number> = [];
  if (cursor) {
    where.push(
      `(i.created_at < ? OR (i.created_at = ? AND i.id < ?))`,
    );
    bindings.push(cursor.createdAt, cursor.createdAt, cursor.id);
  }
  bindings.push(21);

  const result = await context.env.CFORUM_DB.prepare(
    `SELECT
       i.id, i.max_uses, i.used_count, i.expires_at, i.revoked_at,
       i.created_at, creator.id AS created_by_id,
       creator.username AS created_by_username,
       creator.display_name AS created_by_display_name
     FROM invites i
     JOIN users creator ON creator.id = i.created_by
     ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY i.created_at DESC, i.id DESC
     LIMIT ?`,
  )
    .bind(...bindings)
    .all<InviteRow>();
  const hasMore = result.results.length > 20;
  const rows = result.results.slice(0, 20);
  const last = rows.at(-1);
  const now = nowSeconds();

  return context.json({
    items: rows.map((row) => serializeInvite(row, now)),
    nextCursor:
      hasMore && last
        ? encodeCursor({ createdAt: last.created_at, id: last.id })
        : null,
  });
});

router.post("/admin/invites", async (context) => {
  const identity = context.get("identity");
  if (!identity.session || !identity.viewer.userId) {
    return context.json({ error: { code: "AUTHENTICATION_REQUIRED" } }, 401);
  }
  const admin = activeAdmin(context);
  if (!admin) {
    return context.json({ error: { code: "ACTION_NOT_ALLOWED" } }, 403);
  }

  const parsed = createInviteSchema.safeParse(
    await context.req.json().catch(() => null),
  );
  if (!parsed.success) {
    return context.json({ error: { code: "INVALID_INPUT" } }, 422);
  }
  if (context.env.INVITE_HMAC_SECRET.trim().length < 32) {
    return context.json(
      { error: { code: "INVITE_SERVICE_UNAVAILABLE" } },
      503,
    );
  }

  const creator = await context.env.CFORUM_DB.prepare(
    `SELECT id, username, display_name
     FROM users WHERE id = ?1 LIMIT 1`,
  )
    .bind(admin.userId)
    .first<{ id: string; username: string; display_name: string }>();
  if (!creator) {
    return context.json({ error: { code: "AUTHENTICATION_REQUIRED" } }, 401);
  }

  const token = randomToken(32);
  const tokenHash = await hashInviteToken(
    context.env.INVITE_HMAC_SECRET,
    token,
  );
  const inviteId = crypto.randomUUID();
  const now = nowSeconds();
  await context.env.CFORUM_DB.batch([
    context.env.CFORUM_DB.prepare(
      `INSERT INTO invites(
         id, token_hash, created_by, max_uses, used_count,
         expires_at, revoked_at, auto_group_id, redirect_topic_id, created_at
       ) VALUES (?1, ?2, ?3, ?4, 0, NULL, NULL, NULL, NULL, ?5)`,
    ).bind(inviteId, tokenHash, admin.userId, parsed.data.maxUses, now),
    context.env.CFORUM_DB.prepare(
      `INSERT INTO audit_logs(
         id, occurred_at, actor_user_id, actor_role, action, target_type,
         target_id, request_id, after_json
       ) VALUES (?1, ?2, ?3, 'admin', 'invite.create', 'invite', ?4, ?5, ?6)`,
    ).bind(
      crypto.randomUUID(),
      now,
      admin.userId,
      inviteId,
      context.get("requestId"),
      JSON.stringify({ maxUses: parsed.data.maxUses }),
    ),
  ]);

  return context.json(
    {
      invite: serializeInvite(
        {
          id: inviteId,
          max_uses: parsed.data.maxUses,
          used_count: 0,
          expires_at: null,
          revoked_at: null,
          created_at: now,
          created_by_id: creator.id,
          created_by_username: creator.username,
          created_by_display_name: creator.display_name,
        },
        now,
      ),
      token,
    },
    201,
  );
});

router.patch("/admin/invites/:id", async (context) => {
  const identity = context.get("identity");
  if (!identity.session || !identity.viewer.userId) {
    return context.json({ error: { code: "AUTHENTICATION_REQUIRED" } }, 401);
  }
  const admin = activeAdmin(context);
  if (!admin) {
    return context.json({ error: { code: "ACTION_NOT_ALLOWED" } }, 403);
  }

  const inviteId = context.req.param("id");
  if (!idSchema.safeParse(inviteId).success) {
    return context.json({ error: { code: "NOT_FOUND" } }, 404);
  }
  const parsed = revokeInviteSchema.safeParse(
    await context.req.json().catch(() => null),
  );
  if (!parsed.success) {
    return context.json({ error: { code: "INVALID_INPUT" } }, 422);
  }

  let invite = await selectInviteById(context.env.CFORUM_DB, inviteId);
  if (!invite) {
    return context.json({ error: { code: "NOT_FOUND" } }, 404);
  }

  if (invite.revoked_at === null) {
    const now = nowSeconds();
    await context.env.CFORUM_DB.batch([
      context.env.CFORUM_DB.prepare(
        `UPDATE invites
         SET revoked_at = ?2
         WHERE id = ?1 AND revoked_at IS NULL`,
      ).bind(inviteId, now),
      context.env.CFORUM_DB.prepare(
        `INSERT INTO audit_logs(
           id, occurred_at, actor_user_id, actor_role, action, target_type,
           target_id, request_id, before_json, after_json
         )
         SELECT ?1, ?2, ?3, 'admin', 'invite.revoke', 'invite', ?4, ?5,
                '{"revoked":false}', '{"revoked":true}'
         WHERE changes() = 1`,
      ).bind(
        crypto.randomUUID(),
        now,
        admin.userId,
        inviteId,
        context.get("requestId"),
      ),
    ]);
    invite = await selectInviteById(context.env.CFORUM_DB, inviteId);
    if (!invite) {
      return context.json({ error: { code: "NOT_FOUND" } }, 404);
    }
  }

  return context.json({ invite: serializeInvite(invite, nowSeconds()) });
});

export default router;
