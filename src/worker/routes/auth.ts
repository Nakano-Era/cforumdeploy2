import { Hono } from "hono";
import { deleteCookie } from "hono/cookie";
import { z } from "zod";
import {
  OTP_PURPOSES,
  OTP_RESEND_SECONDS,
  OTP_TTL_SECONDS,
  normalizeEmail,
  requestEmailCode,
  verifyEmailCode,
  hashVerificationTicket,
} from "@/worker/auth/otp";
import {
  CSRF_COOKIE,
  DEV_SESSION_COOKIE,
  SESSION_COOKIE,
  prepareSession,
  setSessionCookies,
} from "@/worker/auth/session";
import type { AppEnv } from "@/worker/env";
import { hmacSha256, nowSeconds, timingSafeEqual } from "@/worker/security/crypto";
import {
  EMAIL_REQUEST_TURNSTILE_ACTION,
  verifyTurnstileToken,
} from "@/worker/security/turnstile";
import { avatarUrl } from "@/worker/media/avatar-url";

const emailSchema = z
  .string()
  .trim()
  .min(3)
  .max(254)
  .transform(normalizeEmail)
  .pipe(z.string().email().max(254));

export const requestCodeSchema = z.object({
  email: emailSchema,
  purpose: z.enum(OTP_PURPOSES).default("register"),
  turnstileToken: z.string().trim().min(1).max(2048),
});

export const verifyCodeSchema = z.object({
  challengeId: z.string().uuid(),
  email: emailSchema,
  code: z.string().regex(/^\d{8}$/),
});

const registerSchema = z.object({
  email: emailSchema,
  challengeId: z.string().uuid(),
  verificationTicket: z.string().min(32).max(256),
  username: z
    .string()
    .trim()
    .min(3)
    .max(32)
    .regex(/^[\p{L}\p{N}_-]+$/u),
  displayName: z.string().trim().min(1).max(80),
  inviteToken: z.string().trim().min(16).max(512).optional(),
  turnstileToken: z.string().trim().min(1).max(2048),
});

const consumeLoginSchema = z.object({
  email: emailSchema,
  challengeId: z.string().uuid(),
  verificationTicket: z.string().min(32).max(256),
});

const REGISTRATION_TURNSTILE_ACTION = "registration_submit";
const registrationModeSettingSchema = z.enum([
  "open",
  "approval",
  "invite_only",
]);
const booleanSettingSchema = z.boolean();
const disabledEmailDomainsSettingSchema = z.array(z.string());

type RegistrationMode = z.infer<typeof registrationModeSettingSchema>;

interface InviteRow {
  id: string;
  email_hash: string | null;
  allowed_domain: string | null;
  max_uses: number;
  used_count: number;
  expires_at: number | null;
  revoked_at: number | null;
  auto_group_id: string | null;
}

async function getSetting<T>(
  database: D1Database,
  key: string,
): Promise<T | null> {
  const row = await database
    .prepare("SELECT value_json FROM site_settings WHERE key = ?1 LIMIT 1")
    .bind(key)
    .first<{ value_json: string }>();
  if (!row) return null;
  try {
    return JSON.parse(row.value_json) as T;
  } catch {
    return null;
  }
}

export async function hashInviteToken(secret: string, token: string): Promise<string> {
  return hmacSha256(secret, `cforum:invite-token:v1:${token}`);
}

async function hashInviteEmail(secret: string, email: string): Promise<string> {
  return hmacSha256(secret, `cforum:invite-email:v1:${normalizeEmail(email)}`);
}

const router = new Hono<AppEnv>();

function invalidInput(error: z.ZodError) {
  return {
    error: {
      code: "INVALID_INPUT",
      fields: error.flatten().fieldErrors,
    },
  };
}

router.post("/email/request-code", async (context) => {
  const parsed = requestCodeSchema.safeParse(
    await context.req.json().catch(() => null),
  );
  if (!parsed.success) {
    return context.json(invalidInput(parsed.error), 422);
  }

  const turnstileValid = await verifyTurnstileToken(context.env, {
    token: parsed.data.turnstileToken,
    expectedAction: EMAIL_REQUEST_TURNSTILE_ACTION,
    remoteIp: context.req.header("CF-Connecting-IP"),
  });
  if (!turnstileValid) {
    return context.json({ error: { code: "TURNSTILE_FAILED" } }, 403);
  }

  try {
    const result = await requestEmailCode(context.env, parsed.data);
    // Do not expose whether an account, quota slot, provider, or challenge exists.
    return context.json(
      {
        accepted: true,
        challengeId: result.challengeId,
        expiresInSeconds: OTP_TTL_SECONDS,
        resendAfterSeconds: OTP_RESEND_SECONDS,
        message: "If the request is eligible, a verification code will be sent.",
      },
      202,
    );
  } catch {
    return context.json({ error: { code: "AUTH_SERVICE_UNAVAILABLE" } }, 503);
  }
});

router.post("/email/verify", async (context) => {
  const parsed = verifyCodeSchema.safeParse(
    await context.req.json().catch(() => null),
  );
  if (!parsed.success) {
    return context.json(invalidInput(parsed.error), 422);
  }

  try {
    const result = await verifyEmailCode(context.env, parsed.data);
    if (!result.verified) {
      return context.json(
        { error: { code: "INVALID_OR_EXPIRED_VERIFICATION_CODE" } },
        400,
      );
    }

    return context.json({
      verified: true,
      challengeId: result.challengeId,
      email: result.email,
      purpose: result.purpose,
      verificationTicket: result.verificationTicket,
      expiresInSeconds: OTP_TTL_SECONDS,
    });
  } catch {
    return context.json({ error: { code: "AUTH_SERVICE_UNAVAILABLE" } }, 503);
  }
});

router.post("/register", async (context) => {
  const parsed = registerSchema.safeParse(
    await context.req.json().catch(() => null),
  );
  if (!parsed.success) {
    return context.json(invalidInput(parsed.error), 422);
  }

  const turnstileValid = await verifyTurnstileToken(context.env, {
    token: parsed.data.turnstileToken,
    expectedAction: REGISTRATION_TURNSTILE_ACTION,
    remoteIp: context.req.header("CF-Connecting-IP"),
  });
  if (!turnstileValid) {
    return context.json({ error: { code: "TURNSTILE_FAILED" } }, 403);
  }

  const now = nowSeconds();
  const [
    registrationModeValue,
    registrationFrozenValue,
    inviteRequiresApprovalValue,
    disabledDomainsValue,
  ] =
    await Promise.all([
      getSetting<unknown>(context.env.CFORUM_DB, "registration_mode"),
      getSetting<unknown>(context.env.CFORUM_DB, "registration_frozen"),
      getSetting<unknown>(context.env.CFORUM_DB, "invite_requires_approval"),
      getSetting<unknown>(context.env.CFORUM_DB, "disabled_email_domains"),
    ]);
  const registrationModeResult = registrationModeSettingSchema.safeParse(
    registrationModeValue,
  );
  const registrationFrozenResult = booleanSettingSchema.safeParse(
    registrationFrozenValue,
  );
  const inviteRequiresApprovalResult = booleanSettingSchema.safeParse(
    inviteRequiresApprovalValue,
  );
  const disabledDomainsResult = disabledEmailDomainsSettingSchema.safeParse(
    disabledDomainsValue,
  );
  if (
    !registrationModeResult.success ||
    !registrationFrozenResult.success ||
    registrationFrozenResult.data ||
    !inviteRequiresApprovalResult.success ||
    !disabledDomainsResult.success
  ) {
    return context.json({ error: { code: "REGISTRATION_NOT_AVAILABLE" } }, 403);
  }
  const registrationMode: RegistrationMode = registrationModeResult.data;
  const inviteRequiresApproval = inviteRequiresApprovalResult.data;
  const disabledDomains = disabledDomainsResult.data;

  const emailDomain = parsed.data.email.slice(
    parsed.data.email.lastIndexOf("@") + 1,
  );
  if (disabledDomains.some((domain) => domain.toLowerCase() === emailDomain)) {
    return context.json({ error: { code: "REGISTRATION_NOT_AVAILABLE" } }, 403);
  }

  const expectedTicketHash = await hashVerificationTicket(
    context.env.OTP_HMAC_SECRET,
    parsed.data.challengeId,
    parsed.data.email,
    parsed.data.verificationTicket,
  );
  const verification = await context.env.CFORUM_DB.prepare(
    `SELECT code_hash
     FROM email_verifications
     WHERE challenge_id = ?1
       AND email_normalized = ?2
       AND purpose = 'register'
       AND status = 'verified'
       AND consumed_at IS NULL
       AND expires_at > ?3
     LIMIT 1`,
  )
    .bind(parsed.data.challengeId, parsed.data.email, now)
    .first<{ code_hash: string }>();
  if (!verification || !timingSafeEqual(verification.code_hash, expectedTicketHash)) {
    return context.json(
      { error: { code: "INVALID_OR_EXPIRED_VERIFICATION_TICKET" } },
      400,
    );
  }

  let invite: InviteRow | null = null;
  let inviteEmailHash: string | null = null;
  if (registrationMode === "invite_only" || parsed.data.inviteToken) {
    if (
      !parsed.data.inviteToken ||
      context.env.INVITE_HMAC_SECRET.trim().length < 32
    ) {
      return context.json({ error: { code: "INVITATION_REQUIRED" } }, 403);
    }
    const [tokenHash, emailHash] = await Promise.all([
      hashInviteToken(context.env.INVITE_HMAC_SECRET, parsed.data.inviteToken),
      hashInviteEmail(context.env.INVITE_HMAC_SECRET, parsed.data.email),
    ]);
    inviteEmailHash = emailHash;
    invite = await context.env.CFORUM_DB.prepare(
      `SELECT
         id, email_hash, allowed_domain, max_uses, used_count,
         expires_at, revoked_at, auto_group_id
       FROM invites
       WHERE token_hash = ?1
       LIMIT 1`,
    )
      .bind(tokenHash)
      .first<InviteRow>();
    const inviteValid =
      invite !== null &&
      invite.revoked_at === null &&
      (invite.expires_at === null || invite.expires_at > now) &&
      invite.used_count < invite.max_uses &&
      (invite.email_hash === null ||
        timingSafeEqual(invite.email_hash, emailHash)) &&
      (invite.allowed_domain === null ||
        invite.allowed_domain.toLowerCase() === emailDomain);
    if (!inviteValid) {
      return context.json({ error: { code: "INVITATION_INVALID" } }, 403);
    }
  }

  const requiresApproval =
    registrationMode === "approval" ||
    (registrationMode === "invite_only" && inviteRequiresApproval === true);
  const userStatus = requiresApproval ? "pending" : "active";
  const requestStatus = requiresApproval ? "pending_review" : "approved";
  const userId = crypto.randomUUID();
  const preparedSession = requiresApproval
    ? null
    : await prepareSession(context.env, userId);
  const statements: D1PreparedStatement[] = [
    context.env.CFORUM_DB.prepare(
      `UPDATE email_verifications
       SET consumed_at = ?4
       WHERE challenge_id = ?1
         AND email_normalized = ?2
         AND purpose = 'register'
         AND code_hash = ?3
         AND status = 'verified'
         AND consumed_at IS NULL
         AND expires_at > ?4`,
    ).bind(
      parsed.data.challengeId,
      parsed.data.email,
      expectedTicketHash,
      now,
    ),
  ];

  if (invite) {
    statements.push(
      context.env.CFORUM_DB.prepare(
        `UPDATE invites
         SET used_count = used_count + 1
         WHERE id = ?1
            AND revoked_at IS NULL
            AND (expires_at IS NULL OR expires_at > ?2)
            AND used_count < max_uses
            AND changes() = 1`,
       ).bind(invite.id, now),
    );
  }

  statements.push(
    context.env.CFORUM_DB.prepare(
      `INSERT INTO users(
         id, username, display_name, trust_level, role, status,
         level_locked, created_at, updated_at
       )
       SELECT ?1, ?2, ?3, 0, 'member', ?4, 0, ?5, ?5
       WHERE changes() = 1`,
    ).bind(
      userId,
      parsed.data.username,
      parsed.data.displayName,
      userStatus,
      now,
    ),
    context.env.CFORUM_DB.prepare(
      `INSERT INTO user_emails(
         id, user_id, email_normalized, is_primary, verified_at, created_at
       ) VALUES (?1, ?2, ?3, 1, ?4, ?4)`,
    ).bind(crypto.randomUUID(), userId, parsed.data.email, now),
    context.env.CFORUM_DB.prepare(
      `INSERT INTO registration_requests(
         id, user_id, email_normalized, username, display_name,
         invite_id, status, submitted_at, decided_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
    ).bind(
      crypto.randomUUID(),
      userId,
      parsed.data.email,
      parsed.data.username,
      parsed.data.displayName,
      invite?.id ?? null,
      requestStatus,
      now,
      requiresApproval ? null : now,
    ),
  );

  if (invite) {
    statements.push(
      context.env.CFORUM_DB.prepare(
        `INSERT INTO invite_uses(id, invite_id, user_id, email_hash, used_at)
         VALUES (?1, ?2, ?3, ?4, ?5)`,
      ).bind(
        crypto.randomUUID(),
        invite.id,
        userId,
        inviteEmailHash,
        now,
      ),
    );
    if (invite.auto_group_id) {
      statements.push(
        context.env.CFORUM_DB.prepare(
          `INSERT INTO group_members(group_id, user_id, created_at)
           VALUES (?1, ?2, ?3)`,
        ).bind(invite.auto_group_id, userId, now),
      );
    }
  }

  if (requiresApproval) {
    statements.push(
      context.env.CFORUM_DB.prepare(
        `INSERT INTO review_items(
           id, type, submitted_by, target_user_id, trigger_reason,
           content_snapshot_json, priority, created_at
         ) VALUES (?1, 'registration', ?2, ?2, 'registration_mode', ?3, 0, ?4)`,
      ).bind(
        crypto.randomUUID(),
        userId,
        JSON.stringify({
          username: parsed.data.username,
          displayName: parsed.data.displayName,
        }),
        now,
      ),
    );
  }
  if (preparedSession) statements.push(preparedSession.statement);
  statements.push(
    context.env.CFORUM_DB.prepare(
      `INSERT INTO audit_logs(
         id, occurred_at, actor_user_id, actor_role, action, target_type,
         target_id, request_id, after_json
       ) VALUES (?1, ?2, ?3, 'member', 'account.register', 'user', ?3, ?4, ?5)`,
    ).bind(
      crypto.randomUUID(),
      now,
      userId,
      context.get("requestId"),
      JSON.stringify({ status: userStatus, mode: registrationMode }),
    ),
  );

  try {
    const results = await context.env.CFORUM_DB.batch(statements);
    const userInsertIndex = invite ? 2 : 1;
    if (Number(results[userInsertIndex]?.meta.changes ?? 0) !== 1) {
      throw new Error("registration_guard_failed");
    }
  } catch {
    return context.json({ error: { code: "REGISTRATION_CONFLICT" } }, 409);
  }

  if (preparedSession) setSessionCookies(context, preparedSession);
  return context.json(
    {
      registration: {
        status: requiresApproval ? "pending_review" : "active",
        passkeySetupRecommended: true,
      },
      ...(preparedSession
        ? {
            user: {
              id: userId,
              username: parsed.data.username,
              displayName: parsed.data.displayName,
              trustLevel: 0,
              role: "member",
            },
            csrfToken: preparedSession.csrfToken,
          }
        : {}),
    },
    requiresApproval ? 202 : 201,
  );
});

router.post("/email/consume-login", async (context) => {
  const parsed = consumeLoginSchema.safeParse(
    await context.req.json().catch(() => null),
  );
  if (!parsed.success) {
    return context.json(invalidInput(parsed.error), 422);
  }
  const now = nowSeconds();
  const expectedTicketHash = await hashVerificationTicket(
    context.env.OTP_HMAC_SECRET,
    parsed.data.challengeId,
    parsed.data.email,
    parsed.data.verificationTicket,
  );
  const account = await context.env.CFORUM_DB.prepare(
    `SELECT
       ev.code_hash,
       u.id, u.username, u.display_name, u.trust_level, u.role, u.status,
       u.avatar_upload_id
     FROM email_verifications ev
     JOIN user_emails ue ON ue.email_normalized = ev.email_normalized
     JOIN users u ON u.id = ue.user_id
     WHERE ev.challenge_id = ?1
       AND ev.email_normalized = ?2
       AND ev.purpose = 'login'
       AND ev.status = 'verified'
       AND ev.consumed_at IS NULL
       AND ev.expires_at > ?3
       AND u.status IN ('active', 'silenced')
     LIMIT 1`,
  )
    .bind(parsed.data.challengeId, parsed.data.email, now)
    .first<{
      code_hash: string;
      id: string;
      username: string;
      display_name: string;
      trust_level: number;
      role: string;
      status: string;
      avatar_upload_id: string | null;
    }>();
  if (!account || !timingSafeEqual(account.code_hash, expectedTicketHash)) {
    return context.json(
      { error: { code: "INVALID_OR_EXPIRED_VERIFICATION_TICKET" } },
      400,
    );
  }

  const preparedSession = await prepareSession(context.env, account.id);
  const results = await context.env.CFORUM_DB.batch([
    context.env.CFORUM_DB.prepare(
      `UPDATE email_verifications
       SET consumed_at = ?4
       WHERE challenge_id = ?1
         AND email_normalized = ?2
         AND purpose = 'login'
         AND code_hash = ?3
         AND status = 'verified'
         AND consumed_at IS NULL
         AND expires_at > ?4`,
    ).bind(
      parsed.data.challengeId,
      parsed.data.email,
      expectedTicketHash,
      now,
    ),
    preparedSession.guardedStatement,
    context.env.CFORUM_DB.prepare(
      `INSERT INTO audit_logs(
         id, occurred_at, actor_user_id, actor_role, action, target_type,
         target_id, request_id
       )
       SELECT ?1, ?2, ?3, ?4, 'session.email_login', 'user', ?3, ?5
       WHERE changes() = 1`,
    ).bind(
      crypto.randomUUID(),
      now,
      account.id,
      account.role,
      context.get("requestId"),
    ),
  ]);
  if (Number(results[1]?.meta.changes ?? 0) !== 1) {
    return context.json(
      { error: { code: "INVALID_OR_EXPIRED_VERIFICATION_TICKET" } },
      400,
    );
  }
  setSessionCookies(context, preparedSession);

  return context.json({
    user: {
      id: account.id,
      username: account.username,
      displayName: account.display_name,
      trustLevel: account.trust_level,
      role: account.role,
      status: account.status,
      avatarUrl: avatarUrl(account.avatar_upload_id),
    },
    csrfToken: preparedSession.csrfToken,
  });
});

router.get("/session", async (context) => {
  const identity = context.get("identity");
  if (!identity.viewer.userId || !identity.session) {
    return context.json({ authenticated: false });
  }
  const user = await context.env.CFORUM_DB.prepare(
    `SELECT id, username, display_name, trust_level, role, status,
            avatar_upload_id
     FROM users WHERE id = ?1 LIMIT 1`,
  )
    .bind(identity.viewer.userId)
    .first<{
      id: string;
      username: string;
      display_name: string;
      trust_level: number;
      role: string;
      status: string;
      avatar_upload_id: string | null;
    }>();
  if (!user) return context.json({ authenticated: false });
  return context.json({
    authenticated: true,
    user: {
      id: user.id,
      username: user.username,
      displayName: user.display_name,
      trustLevel: user.trust_level,
      role: user.role,
      status: user.status,
      avatarUrl: avatarUrl(user.avatar_upload_id),
    },
  });
});

router.post("/logout", async (context) => {
  const identity = context.get("identity");
  if (identity.session) {
    await context.env.CFORUM_DB.prepare(
      "UPDATE sessions SET revoked_at = ?2 WHERE id = ?1 AND revoked_at IS NULL",
    )
      .bind(identity.session.id, nowSeconds())
      .run();
  }
  deleteCookie(context, SESSION_COOKIE, { path: "/" });
  deleteCookie(context, DEV_SESSION_COOKIE, { path: "/" });
  deleteCookie(context, CSRF_COOKIE, { path: "/" });
  return context.body(null, 204);
});

router.post("/logout-all", async (context) => {
  const identity = context.get("identity");
  if (!identity.viewer.userId) {
    return context.json({ error: { code: "AUTHENTICATION_REQUIRED" } }, 401);
  }
  await context.env.CFORUM_DB.prepare(
    `UPDATE sessions SET revoked_at = ?2
     WHERE user_id = ?1 AND revoked_at IS NULL`,
  )
    .bind(identity.viewer.userId, nowSeconds())
    .run();
  deleteCookie(context, SESSION_COOKIE, { path: "/" });
  deleteCookie(context, DEV_SESSION_COOKIE, { path: "/" });
  deleteCookie(context, CSRF_COOKIE, { path: "/" });
  return context.body(null, 204);
});

export default router;
