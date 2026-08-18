import { Hono } from "hono";
import { z } from "zod";
import type { UserRole, UserStatus } from "@/shared/domain";
import type { AppEnv } from "@/worker/env";
import { nowSeconds } from "@/worker/security/crypto";

const router = new Hono<AppEnv>();

const idSchema = z.string().min(1).max(80).regex(/^[A-Za-z0-9_-]+$/);
const trustLevelSchema = z.number().int().min(0).max(4);

export const adminUserListQuerySchema = z
  .object({
    q: z.string().trim().min(1).max(80).optional(),
    role: z.enum(["member", "moderator", "admin"]).optional(),
    status: z
      .enum(["pending", "active", "silenced", "suspended", "deleted"])
      .optional(),
    cursor: z.string().max(512).optional(),
  })
  .strict();

export const adminUserPatchSchema = z
  .object({
    role: z.enum(["member", "moderator", "admin"]).optional(),
    trustLevel: trustLevelSchema.optional(),
    levelLocked: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.values(value).some((item) => item !== undefined), {
    message: "至少提供一项用户设置",
  });

export const adminCategoryCreateSchema = z
  .object({
    slug: z
      .string()
      .trim()
      .toLowerCase()
      .min(2)
      .max(60)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    name: z.string().trim().min(1).max(80),
    description: z.string().trim().max(500).default(""),
    color: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^#[0-9a-f]{6}$/)
      .default("#737373"),
    aclMode: z.enum(["open", "restricted"]).default("open"),
    minViewLevel: trustLevelSchema.default(0),
    minCreateLevel: trustLevelSchema.default(0),
    minReplyLevel: trustLevelSchema.default(0),
    allowedTopicMinLevelMax: trustLevelSchema.default(4),
    allowImages: z.boolean().default(true),
    requireTopicApproval: z.boolean().default(false),
    requireReplyApproval: z.boolean().default(false),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.minCreateLevel < value.minViewLevel) {
      context.addIssue({
        code: "custom",
        path: ["minCreateLevel"],
        message: "发主题等级不能低于查看等级",
      });
    }
    if (value.minReplyLevel < value.minViewLevel) {
      context.addIssue({
        code: "custom",
        path: ["minReplyLevel"],
        message: "回复等级不能低于查看等级",
      });
    }
    if (value.allowedTopicMinLevelMax < value.minViewLevel) {
      context.addIssue({
        code: "custom",
        path: ["allowedTopicMinLevelMax"],
        message: "主题可选等级上限不能低于板块查看等级",
      });
    }
  });

interface UserCursor {
  createdAt: number;
  id: string;
}

const userCursorSchema = z.object({
  createdAt: z.number().int().nonnegative(),
  id: idSchema,
});

interface AdminUserRow {
  id: string;
  username: string;
  display_name: string;
  email: string | null;
  role: UserRole;
  trust_level: number;
  level_locked: number;
  status: UserStatus;
  next_level_review_at: number | null;
  created_at: number;
  updated_at: number;
}

interface AdminCategoryRow {
  id: string;
  slug: string;
  name: string;
  description: string;
  color: string;
  state: "active" | "archived" | "deleted";
  acl_mode: "open" | "restricted";
  min_view_level: number;
  min_create_level: number;
  min_reply_level: number;
  allowed_topic_min_level_max: number;
  allow_images: number;
  require_topic_approval: number;
  require_reply_approval: number;
  position: number;
  created_at: number;
  updated_at: number;
}

const userSelectColumns = `
  u.id, u.username, u.display_name,
  (SELECT ue.email_normalized
   FROM user_emails ue
   WHERE ue.user_id = u.id
   ORDER BY ue.is_primary DESC, ue.created_at, ue.id
   LIMIT 1) AS email,
  u.role, u.trust_level, u.level_locked, u.status,
  u.next_level_review_at, u.created_at, u.updated_at
`;

const categorySelectColumns = `
  id, slug, name, description, color, state, acl_mode,
  min_view_level, min_create_level, min_reply_level,
  allowed_topic_min_level_max, allow_images,
  require_topic_approval, require_reply_approval,
  position, created_at, updated_at
`;

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

function encodeCursor(cursor: UserCursor): string {
  return btoa(JSON.stringify(cursor))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function decodeCursor(value: string | undefined): UserCursor | null {
  if (!value) return null;
  try {
    const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const parsed = userCursorSchema.safeParse(JSON.parse(atob(padded)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function isoFromSeconds(value: number | null): string | null {
  return value === null ? null : new Date(value * 1_000).toISOString();
}

function escapeLike(value: string): string {
  return `%${value.replace(/[\\%_]/g, "\\$&")}%`;
}

function serializeUser(row: AdminUserRow) {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    email: row.email,
    role: row.role,
    trustLevel: row.trust_level,
    levelLocked: row.level_locked === 1,
    status: row.status,
    nextLevelReviewAt: isoFromSeconds(row.next_level_review_at),
    createdAt: isoFromSeconds(row.created_at),
    updatedAt: isoFromSeconds(row.updated_at),
  };
}

function serializeCategory(row: AdminCategoryRow) {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    color: row.color,
    state: row.state,
    aclMode: row.acl_mode,
    minViewLevel: row.min_view_level,
    minCreateLevel: row.min_create_level,
    minReplyLevel: row.min_reply_level,
    allowedTopicMinLevelMax: row.allowed_topic_min_level_max,
    allowImages: row.allow_images === 1,
    requireTopicApproval: row.require_topic_approval === 1,
    requireReplyApproval: row.require_reply_approval === 1,
    position: row.position,
    createdAt: isoFromSeconds(row.created_at),
    updatedAt: isoFromSeconds(row.updated_at),
  };
}

function selectUserById(database: D1Database, userId: string) {
  return database
    .prepare(
      `SELECT ${userSelectColumns}
       FROM users u
       WHERE u.id = ?1
       LIMIT 1`,
    )
    .bind(userId)
    .first<AdminUserRow>();
}

function selectCategoryById(database: D1Database, categoryId: string) {
  return database
    .prepare(
      `SELECT ${categorySelectColumns}
       FROM categories
       WHERE id = ?1
       LIMIT 1`,
    )
    .bind(categoryId)
    .first<AdminCategoryRow>();
}

function authFailure(context: Parameters<typeof activeAdmin>[0]) {
  const identity = context.get("identity");
  return !identity.session || !identity.viewer.userId ? 401 : 403;
}

router.get("/admin/users", async (context) => {
  if (!activeAdmin(context)) {
    const status = authFailure(context);
    return context.json(
      {
        error: {
          code:
            status === 401 ? "AUTHENTICATION_REQUIRED" : "ACTION_NOT_ALLOWED",
        },
      },
      status,
    );
  }

  const parsed = adminUserListQuerySchema.safeParse(context.req.query());
  if (!parsed.success) {
    return context.json({ error: { code: "INVALID_QUERY" } }, 422);
  }
  const cursor = decodeCursor(parsed.data.cursor);
  if (parsed.data.cursor && !cursor) {
    return context.json({ error: { code: "INVALID_CURSOR" } }, 422);
  }

  const where: string[] = [];
  const bindings: Array<string | number> = [];
  if (parsed.data.q) {
    const search = escapeLike(parsed.data.q);
    where.push(
      `(u.username LIKE ? ESCAPE '\\' COLLATE NOCASE
        OR u.display_name LIKE ? ESCAPE '\\' COLLATE NOCASE
        OR EXISTS (
          SELECT 1 FROM user_emails search_email
          WHERE search_email.user_id = u.id
            AND search_email.email_normalized LIKE ? ESCAPE '\\' COLLATE NOCASE
        ))`,
    );
    bindings.push(search, search, search);
  }
  if (parsed.data.role) {
    where.push("u.role = ?");
    bindings.push(parsed.data.role);
  }
  if (parsed.data.status) {
    where.push("u.status = ?");
    bindings.push(parsed.data.status);
  }
  if (cursor) {
    where.push("(u.created_at < ? OR (u.created_at = ? AND u.id < ?))");
    bindings.push(cursor.createdAt, cursor.createdAt, cursor.id);
  }
  bindings.push(21);

  const result = await context.env.CFORUM_DB.prepare(
    `SELECT ${userSelectColumns}
     FROM users u
     ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY u.created_at DESC, u.id DESC
     LIMIT ?`,
  )
    .bind(...bindings)
    .all<AdminUserRow>();
  const hasMore = result.results.length > 20;
  const rows = result.results.slice(0, 20);
  const last = rows.at(-1);

  return context.json({
    items: rows.map(serializeUser),
    nextCursor:
      hasMore && last
        ? encodeCursor({ createdAt: last.created_at, id: last.id })
        : null,
  });
});

router.patch("/admin/users/:id", async (context) => {
  const admin = activeAdmin(context);
  if (!admin) {
    const status = authFailure(context);
    return context.json(
      {
        error: {
          code:
            status === 401 ? "AUTHENTICATION_REQUIRED" : "ACTION_NOT_ALLOWED",
        },
      },
      status,
    );
  }

  const userId = context.req.param("id");
  if (!idSchema.safeParse(userId).success) {
    return context.json({ error: { code: "NOT_FOUND" } }, 404);
  }
  const parsed = adminUserPatchSchema.safeParse(
    await context.req.json().catch(() => null),
  );
  if (!parsed.success) {
    return context.json(
      {
        error: {
          code: "INVALID_INPUT",
          fields: parsed.error.flatten().fieldErrors,
        },
      },
      422,
    );
  }

  const before = await selectUserById(context.env.CFORUM_DB, userId);
  if (!before) {
    return context.json({ error: { code: "NOT_FOUND" } }, 404);
  }

  const nextRole = parsed.data.role ?? before.role;
  const nextTrustLevel = parsed.data.trustLevel ?? before.trust_level;
  const trustLevelChanged = nextTrustLevel !== before.trust_level;
  // Lv4 is deliberately manual-only. Keep that invariant in the API as well
  // as the admin UI so direct requests cannot leave a Lv4 user reporting an
  // unlocked (but never automatically reviewed) state.
  const nextLevelLocked =
    nextTrustLevel === 4
      ? true
      : parsed.data.levelLocked ??
        (trustLevelChanged ? true : before.level_locked === 1);
  const lockChanged = nextLevelLocked !== (before.level_locked === 1);
  const roleChanged = nextRole !== before.role;
  if (!trustLevelChanged && !lockChanged && !roleChanged) {
    return context.json({ user: serializeUser(before) });
  }

  const now = nowSeconds();
  const nextReviewAt =
    nextLevelLocked || nextTrustLevel === 4
      ? null
      : trustLevelChanged || lockChanged
        ? now
        : before.next_level_review_at;
  const changed = [
    ...(roleChanged ? ["role"] : []),
    ...(trustLevelChanged ? ["trustLevel"] : []),
    ...(lockChanged ? ["levelLocked"] : []),
  ];
  const beforeAudit = JSON.stringify({
    role: before.role,
    trustLevel: before.trust_level,
    levelLocked: before.level_locked === 1,
  });
  const afterAudit = JSON.stringify({
    role: nextRole,
    trustLevel: nextTrustLevel,
    levelLocked: nextLevelLocked,
  });
  const statements: D1PreparedStatement[] = [
    context.env.CFORUM_DB.prepare(
      `UPDATE users
       SET role = ?2,
           trust_level = ?3,
           level_locked = ?4,
           next_level_review_at = ?5,
           updated_at = ?6
       WHERE id = ?1
         AND role = ?7
         AND trust_level = ?8
         AND level_locked = ?9
         AND status = ?10
         AND updated_at = ?11
         AND next_level_review_at IS ?12
         AND (
           role != 'admin'
           OR status != 'active'
           OR ?2 = 'admin'
           OR EXISTS (
             SELECT 1 FROM users other_admin
             WHERE other_admin.id != users.id
               AND other_admin.role = 'admin'
               AND other_admin.status = 'active'
           )
         )`,
    ).bind(
      userId,
      nextRole,
      nextTrustLevel,
      nextLevelLocked ? 1 : 0,
      nextReviewAt,
      now,
      before.role,
      before.trust_level,
      before.level_locked,
      before.status,
      before.updated_at,
      before.next_level_review_at,
    ),
  ];

  let historyId: string | null = null;
  if (trustLevelChanged) {
    historyId = crypto.randomUUID();
    const notificationKind =
      nextTrustLevel > before.trust_level
        ? "trust_level_promoted"
        : "trust_level_demoted";
    statements.push(
      context.env.CFORUM_DB.prepare(
        `INSERT INTO user_level_history(
           id, user_id, from_level, to_level, reason,
           metrics_snapshot_json, actor_user_id, created_at
         )
         SELECT ?1, ?2, ?3, ?4, 'admin_manual', ?5, ?6, ?7
         WHERE changes() = 1`,
      ).bind(
        historyId,
        userId,
        before.trust_level,
        nextTrustLevel,
        JSON.stringify({ schemaVersion: 1, source: "admin" }),
        admin.userId,
        now,
      ),
      context.env.CFORUM_DB.prepare(
        `INSERT INTO notifications(id, user_id, kind, data_json, created_at)
         SELECT ?1, ?2, ?3, ?4, ?5
         WHERE changes() = 1`,
      ).bind(
        `trust-change:${historyId}`,
        userId,
        notificationKind,
        JSON.stringify({
          fromLevel: before.trust_level,
          toLevel: nextTrustLevel,
          historyId,
          reason: "admin_manual",
          emailQueuedAt: null,
        }),
        now,
      ),
    );
  }

  statements.push(
    context.env.CFORUM_DB.prepare(
      `INSERT INTO audit_logs(
         id, occurred_at, actor_user_id, actor_role, action, target_type,
         target_id, request_id, before_json, after_json, metadata_json
       )
       SELECT ?1, ?2, ?3, 'admin', 'user.admin_update', 'user',
              ?4, ?5, ?6, ?7, ?8
       WHERE changes() = 1`,
    ).bind(
      crypto.randomUUID(),
      now,
      admin.userId,
      userId,
      context.get("requestId"),
      beforeAudit,
      afterAudit,
      JSON.stringify({ changed, historyId }),
    ),
  );

  const results = await context.env.CFORUM_DB.batch(statements);
  if (Number(results[0]?.meta.changes ?? 0) !== 1) {
    const removingLastAdmin =
      before.role === "admin" &&
      before.status === "active" &&
      nextRole !== "admin";
    const current = await selectUserById(context.env.CFORUM_DB, userId);
    const snapshotUnchanged =
      current?.role === before.role &&
      current.trust_level === before.trust_level &&
      current.level_locked === before.level_locked &&
      current.status === before.status &&
      current.next_level_review_at === before.next_level_review_at &&
      current.updated_at === before.updated_at;
    return context.json(
      {
        error: {
          code: removingLastAdmin && snapshotUnchanged
            ? "LAST_ACTIVE_ADMIN_REQUIRED"
            : "USER_CHANGED",
        },
      },
      409,
    );
  }

  const user = await selectUserById(context.env.CFORUM_DB, userId);
  if (!user) {
    return context.json({ error: { code: "NOT_FOUND" } }, 404);
  }
  return context.json({ user: serializeUser(user) });
});

router.get("/admin/categories", async (context) => {
  if (!activeAdmin(context)) {
    const status = authFailure(context);
    return context.json(
      {
        error: {
          code:
            status === 401 ? "AUTHENTICATION_REQUIRED" : "ACTION_NOT_ALLOWED",
        },
      },
      status,
    );
  }

  const result = await context.env.CFORUM_DB.prepare(
    `SELECT ${categorySelectColumns}
     FROM categories
     WHERE state != 'deleted'
     ORDER BY position, id`,
  ).all<AdminCategoryRow>();
  return context.json({ items: result.results.map(serializeCategory) });
});

router.post("/admin/categories", async (context) => {
  const admin = activeAdmin(context);
  if (!admin) {
    const status = authFailure(context);
    return context.json(
      {
        error: {
          code:
            status === 401 ? "AUTHENTICATION_REQUIRED" : "ACTION_NOT_ALLOWED",
        },
      },
      status,
    );
  }

  const parsed = adminCategoryCreateSchema.safeParse(
    await context.req.json().catch(() => null),
  );
  if (!parsed.success) {
    return context.json(
      {
        error: {
          code: "INVALID_INPUT",
          fields: parsed.error.flatten().fieldErrors,
        },
      },
      422,
    );
  }

  const categoryId = crypto.randomUUID();
  const now = nowSeconds();
  const value = parsed.data;
  const category: AdminCategoryRow = {
    id: categoryId,
    slug: value.slug,
    name: value.name,
    description: value.description,
    color: value.color,
    state: "active",
    acl_mode: value.aclMode,
    min_view_level: value.minViewLevel,
    min_create_level: value.minCreateLevel,
    min_reply_level: value.minReplyLevel,
    allowed_topic_min_level_max: value.allowedTopicMinLevelMax,
    allow_images: value.allowImages ? 1 : 0,
    require_topic_approval: value.requireTopicApproval ? 1 : 0,
    require_reply_approval: value.requireReplyApproval ? 1 : 0,
    position: 0,
    created_at: now,
    updated_at: now,
  };
  const statements: D1PreparedStatement[] = [
    context.env.CFORUM_DB.prepare(
      `INSERT OR IGNORE INTO categories(
         id, parent_id, slug, name, description, color, state, acl_mode,
         min_view_level, min_create_level, min_reply_level,
         allowed_topic_min_level_max, require_topic_approval,
         require_reply_approval, allow_images, position, created_at, updated_at
       )
       VALUES (
         ?1, NULL, ?2, ?3, ?4, ?5, 'active', ?6,
         ?7, ?8, ?9, ?10, ?11, ?12, ?13,
         (SELECT COALESCE(MAX(position), -1) + 1
          FROM categories WHERE parent_id IS NULL),
         ?14, ?14
       )`,
    ).bind(
      categoryId,
      value.slug,
      value.name,
      value.description,
      value.color,
      value.aclMode,
      value.minViewLevel,
      value.minCreateLevel,
      value.minReplyLevel,
      value.allowedTopicMinLevelMax,
      value.requireTopicApproval ? 1 : 0,
      value.requireReplyApproval ? 1 : 0,
      value.allowImages ? 1 : 0,
      now,
    ),
  ];

  // Restricted categories created by this basic API are member-only. Group
  // ACL management can later replace these explicit grants without changing
  // the category's fail-closed policy semantics.
  if (value.aclMode === "restricted") {
    for (const action of ["see", "reply", "create"] as const) {
      statements.push(
        context.env.CFORUM_DB.prepare(
          `INSERT INTO category_permissions(
             id, category_id, principal_type, principal_id, action, created_at
           )
           SELECT ?1, ?2, 'authenticated', NULL, ?3, ?4
           WHERE changes() = 1`,
        ).bind(crypto.randomUUID(), categoryId, action, now),
      );
    }
  }

  statements.push(
    context.env.CFORUM_DB.prepare(
      `INSERT INTO audit_logs(
         id, occurred_at, actor_user_id, actor_role, action, target_type,
         target_id, category_id, request_id, after_json
       )
       SELECT ?1, ?2, ?3, 'admin', 'category.create', 'category',
              ?4, ?4, ?5, ?6
       WHERE changes() = 1`,
    ).bind(
      crypto.randomUUID(),
      now,
      admin.userId,
      categoryId,
      context.get("requestId"),
      JSON.stringify({
        id: category.id,
        slug: category.slug,
        name: category.name,
        description: category.description,
        color: category.color,
        aclMode: category.acl_mode,
        minViewLevel: category.min_view_level,
        minCreateLevel: category.min_create_level,
        minReplyLevel: category.min_reply_level,
        allowedTopicMinLevelMax: category.allowed_topic_min_level_max,
        allowImages: category.allow_images === 1,
      }),
    ),
  );

  const results = await context.env.CFORUM_DB.batch(statements);
  if (Number(results[0]?.meta.changes ?? 0) !== 1) {
    return context.json({ error: { code: "CATEGORY_SLUG_TAKEN" } }, 409);
  }

  const created = await selectCategoryById(
    context.env.CFORUM_DB,
    categoryId,
  );
  if (!created) {
    return context.json({ error: { code: "CATEGORY_CREATE_FAILED" } }, 500);
  }
  return context.json({ category: serializeCategory(created) }, 201);
});

export default router;
