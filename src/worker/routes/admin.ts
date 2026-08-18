import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "@/worker/env";
import { nowSeconds } from "@/worker/security/crypto";

const router = new Hono<AppEnv>();

export const adminSettingsSchema = z
  .object({
    siteName: z.string().trim().min(1).max(80).optional(),
    siteDescription: z.string().trim().min(1).max(240).optional(),
    registrationMode: z.enum(["open", "approval", "invite_only"]).optional(),
    registrationFrozen: z.boolean().optional(),
    inviteRequiresApproval: z.boolean().optional(),
    maintenanceMode: z.boolean().optional(),
    lv0FirstTopicsReviewCount: z.number().int().min(0).max(20).optional(),
    lv0FirstRepliesReviewCount: z.number().int().min(0).max(20).optional(),
  })
  .strict()
  .refine((value) => Object.values(value).some((item) => item !== undefined), {
    message: "至少提供一项设置",
  });

type AdminSettingsInput = z.infer<typeof adminSettingsSchema>;

const settingDefinitions = {
  siteName: { key: "site_name", isPublic: 1 },
  siteDescription: { key: "site_description", isPublic: 1 },
  registrationMode: { key: "registration_mode", isPublic: 1 },
  registrationFrozen: { key: "registration_frozen", isPublic: 1 },
  inviteRequiresApproval: { key: "invite_requires_approval", isPublic: 0 },
  maintenanceMode: { key: "maintenance_mode", isPublic: 1 },
  lv0FirstTopicsReviewCount: {
    key: "lv0_first_topics_review_count",
    isPublic: 0,
  },
  lv0FirstRepliesReviewCount: {
    key: "lv0_first_replies_review_count",
    isPublic: 0,
  },
} as const satisfies Record<
  keyof AdminSettingsInput,
  { key: string; isPublic: 0 | 1 }
>;

type SettingField = keyof typeof settingDefinitions;
type SettingValue = Exclude<AdminSettingsInput[SettingField], undefined>;

function isActiveAdmin(context: {
  get(key: "identity"): AppEnv["Variables"]["identity"];
}): boolean {
  const viewer = context.get("identity").viewer;
  return viewer.role === "admin" && viewer.status === "active";
}

function parseSettingsRows(rows: Array<{ key: string; value_json: string }>) {
  const byKey = new Map(rows.map((row) => [row.key, row.value_json]));
  const result: Partial<Record<SettingField, unknown>> = {};
  for (const [field, definition] of Object.entries(settingDefinitions) as Array<
    [SettingField, (typeof settingDefinitions)[SettingField]]
  >) {
    const value = byKey.get(definition.key);
    if (value !== undefined) result[field] = JSON.parse(value) as unknown;
  }
  return result;
}

router.get("/admin/settings", async (context) => {
  if (!context.get("identity").viewer.userId) {
    return context.json({ error: { code: "AUTHENTICATION_REQUIRED" } }, 401);
  }
  if (!isActiveAdmin(context)) {
    return context.json({ error: { code: "ACTION_NOT_ALLOWED" } }, 403);
  }

  const keys = Object.values(settingDefinitions).map(({ key }) => key);
  const placeholders = keys.map(() => "?").join(", ");
  const rows = await context.env.CFORUM_DB.prepare(
    `SELECT key, value_json FROM site_settings WHERE key IN (${placeholders})`,
  )
    .bind(...keys)
    .all<{ key: string; value_json: string }>();

  return context.json({ settings: parseSettingsRows(rows.results) });
});

router.patch("/admin/settings", async (context) => {
  if (!context.get("identity").viewer.userId) {
    return context.json({ error: { code: "AUTHENTICATION_REQUIRED" } }, 401);
  }
  if (!isActiveAdmin(context)) {
    return context.json({ error: { code: "ACTION_NOT_ALLOWED" } }, 403);
  }

  const parsed = adminSettingsSchema.safeParse(
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

  const identity = context.get("identity");
  const userId = identity.viewer.userId;
  if (!userId) {
    return context.json({ error: { code: "AUTHENTICATION_REQUIRED" } }, 401);
  }
  const now = nowSeconds();
  const updates: Array<[SettingField, SettingValue]> = [];
  for (const field of Object.keys(settingDefinitions) as SettingField[]) {
    const value = parsed.data[field];
    if (value !== undefined) updates.push([field, value]);
  }
  const statements = updates.map(([field, value]) => {
    const definition = settingDefinitions[field];
    return context.env.CFORUM_DB.prepare(
      `INSERT INTO site_settings(key, value_json, is_public, updated_by, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT(key) DO UPDATE SET
         value_json = excluded.value_json,
         is_public = excluded.is_public,
         updated_by = excluded.updated_by,
         updated_at = excluded.updated_at`,
    ).bind(
      definition.key,
      JSON.stringify(value),
      definition.isPublic,
      userId,
      now,
    );
  });
  statements.push(
    context.env.CFORUM_DB.prepare(
      `INSERT INTO audit_logs(
         id, occurred_at, actor_user_id, actor_role, action, target_type,
         target_id, request_id, after_json
       ) VALUES (?1, ?2, ?3, 'admin', 'site.settings.update', 'site',
                 'singleton', ?4, ?5)`,
    ).bind(
      crypto.randomUUID(),
      now,
      userId,
      context.get("requestId"),
      JSON.stringify({ changed: updates.map(([field]) => field) }),
    ),
  );
  await context.env.CFORUM_DB.batch(statements);

  return context.json({ settings: parsed.data });
});

export default router;
