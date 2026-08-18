import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "@/worker/env";
import { prepareSession, setSessionCookies } from "@/worker/auth/session";
import { getPublicSiteConfig } from "@/worker/repositories/settings";
import { nowSeconds, timingSafeEqual } from "@/worker/security/crypto";

const router = new Hono<AppEnv>();

const bootstrapSchema = z.object({
  siteName: z.string().trim().min(1).max(80),
  username: z
    .string()
    .trim()
    .min(3)
    .max(32)
    .regex(/^[\p{L}\p{N}_-]+$/u),
  displayName: z.string().trim().min(1).max(80),
  email: z.string().trim().toLowerCase().email().max(254),
  registrationMode: z.enum(["open", "approval", "invite_only"]),
});

router.get("/health", async (context) => {
  const startedAt = performance.now();
  try {
    await context.env.CFORUM_DB.prepare("SELECT 1 AS ok").first();
    return context.json({
      ok: true,
      environment: context.env.ENVIRONMENT,
      database: "ready",
      latencyMs: Math.round(performance.now() - startedAt),
    });
  } catch {
    return context.json(
      {
        ok: false,
        environment: context.env.ENVIRONMENT,
        database: "unavailable",
      },
      503,
    );
  }
});

router.get("/site", async (context) => {
  return context.json(await getPublicSiteConfig(context.env));
});

router.get("/bootstrap/status", async (context) => {
  const claim = await context.env.CFORUM_DB.prepare(
    "SELECT claimed_at FROM bootstrap_claim WHERE singleton = 1",
  ).first<{ claimed_at: number }>();
  return context.json({ installationRequired: !claim });
});

router.post("/bootstrap", async (context) => {
  const authorization = context.req.header("authorization") ?? "";
  const providedSecret = authorization.startsWith("Bootstrap ")
    ? authorization.slice("Bootstrap ".length)
    : "";
  if (
    context.env.BOOTSTRAP_ADMIN_SECRET.length < 24 ||
    !timingSafeEqual(providedSecret, context.env.BOOTSTRAP_ADMIN_SECRET)
  ) {
    return context.json({ error: { code: "NOT_FOUND" } }, 404);
  }

  const parsed = bootstrapSchema.safeParse(await context.req.json().catch(() => null));
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

  const now = nowSeconds();
  const userId = crypto.randomUUID();
  const emailId = crypto.randomUUID();
  const preparedSession = await prepareSession(context.env, userId);
  const requestId = context.get("requestId");

  try {
    await context.env.CFORUM_DB.batch([
      context.env.CFORUM_DB.prepare(
        "INSERT INTO bootstrap_claim(singleton, claimed_at) VALUES (1, ?1)",
      ).bind(now),
      context.env.CFORUM_DB.prepare(
        `INSERT INTO users(
           id, username, display_name, trust_level, role, status,
           level_locked, created_at, updated_at
         ) VALUES (?1, ?2, ?3, 4, 'admin', 'active', 1, ?4, ?4)`,
      ).bind(userId, parsed.data.username, parsed.data.displayName, now),
      context.env.CFORUM_DB.prepare(
        `INSERT INTO user_emails(
           id, user_id, email_normalized, is_primary, verified_at, created_at
         ) VALUES (?1, ?2, ?3, 1, ?4, ?4)`,
      ).bind(emailId, userId, parsed.data.email, now),
      context.env.CFORUM_DB.prepare(
        `UPDATE site_settings
         SET value_json = json_quote(?1), updated_by = ?2, updated_at = ?3
         WHERE key = 'site_name'`,
      ).bind(parsed.data.siteName, userId, now),
      context.env.CFORUM_DB.prepare(
        `UPDATE site_settings
         SET value_json = json_quote(?1), updated_by = ?2, updated_at = ?3
         WHERE key = 'registration_mode'`,
      ).bind(parsed.data.registrationMode, userId, now),
      context.env.CFORUM_DB.prepare(
        `UPDATE site_settings
         SET value_json = 'true', updated_by = ?1, updated_at = ?2
         WHERE key = 'installation_completed'`,
      ).bind(userId, now),
      context.env.CFORUM_DB.prepare(
        `INSERT INTO categories(
           id, slug, name, description, color, acl_mode,
           min_view_level, min_create_level, min_reply_level,
           allowed_topic_min_level_max, position, created_at, updated_at
         ) VALUES
           ('category-announcements', 'announcements', '站务与公告', '社区规则、更新与共同决定', '#d65b43', 'open', 0, 4, 1, 4, 10, ?1, ?1),
           ('category-product', 'product-design', '产品与设计', '产品思考、设计过程与作品复盘', '#397f73', 'open', 0, 0, 0, 4, 20, ?1, ?1),
           ('category-engineering', 'engineering', '工程技术', '代码、架构和正在解决的问题', '#4b6ea9', 'open', 0, 0, 0, 4, 30, ?1, ?1),
           ('category-reading', 'reading-writing', '读书与创作', '阅读札记、写作练习与长期项目', '#9a7144', 'open', 0, 0, 0, 4, 40, ?1, ?1),
           ('category-lounge', 'lounge', '生活与闲聊', '日常观察、城市漫步与轻松话题', '#8b648b', 'open', 1, 1, 1, 4, 50, ?1, ?1)`,
      ).bind(now),
      preparedSession.statement,
      context.env.CFORUM_DB.prepare(
        `INSERT INTO audit_logs(
           id, occurred_at, actor_user_id, actor_role, action, target_type,
           target_id, request_id, after_json
         ) VALUES (?1, ?2, ?3, 'admin', 'site.bootstrap', 'site', 'singleton', ?4, ?5)`,
      ).bind(
        crypto.randomUUID(),
        now,
        userId,
        requestId,
        JSON.stringify({ siteName: parsed.data.siteName }),
      ),
    ]);
  } catch {
    return context.json({ error: { code: "INSTALLATION_ALREADY_CLAIMED" } }, 409);
  }

  setSessionCookies(context, preparedSession);

  return context.json(
    {
      user: {
        id: userId,
        username: parsed.data.username,
        displayName: parsed.data.displayName,
        role: "admin",
        trustLevel: 4,
      },
      csrfToken: preparedSession.csrfToken,
    },
    201,
  );
});

export default router;
