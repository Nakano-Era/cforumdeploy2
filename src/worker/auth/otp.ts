import type { Bindings } from "@/worker/env";
import {
  hmacSha256,
  nowSeconds,
  randomToken,
  timingSafeEqual,
} from "@/worker/security/crypto";

export const OTP_CODE_LENGTH = 8;
export const OTP_TTL_SECONDS = 10 * 60;
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_RESEND_SECONDS = 60;
export const OTP_EMAIL_HOURLY_LIMIT = 5;
export const OTP_EMAIL_DAILY_LIMIT = 10;
export const OTP_PROVIDER_DAILY_LIMIT = 100;
export const OTP_PURPOSES = ["register", "login", "recovery"] as const;

export type OtpPurpose = (typeof OTP_PURPOSES)[number];

const HOUR_SECONDS = 60 * 60;
const DAY_SECONDS = 24 * HOUR_SECONDS;
const ACTIVE_CODE_STATUSES = ["pending", "queued", "sent"] as const;

type VerificationStatus =
  | (typeof ACTIVE_CODE_STATUSES)[number]
  | "verified"
  | "failed"
  | "expired"
  | "invalidated";

interface LatestVerificationRow {
  created_at: number;
  last_sent_at: number | null;
  resend_count: number;
}

interface VerificationRow {
  id: string;
  challenge_id: string;
  email_normalized: string;
  code_hash: string;
  purpose: OtpPurpose;
  status: VerificationStatus;
  attempt_count: number;
  expires_at: number;
  consumed_at: number | null;
}

export interface RequestEmailCodeInput {
  email: string;
  purpose: OtpPurpose;
  now?: number;
}

export interface RequestEmailCodeResult {
  accepted: true;
  challengeId: string;
  expiresAt: number;
  /** Internal only. Never expose this field in an HTTP response. */
  issued: boolean;
}

export type VerifyEmailCodeResult =
  | { verified: false }
  | {
      verified: true;
      challengeId: string;
      email: string;
      purpose: OtpPurpose;
      verificationTicket: string;
      expiresAt: number;
    };

export interface ConsumeVerificationTicketInput {
  challengeId: string;
  email: string;
  purpose: OtpPurpose;
  verificationTicket: string;
  now?: number;
}

type RandomUint32 = () => number;

function secureRandomUint32(): number {
  const values = new Uint32Array(1);
  crypto.getRandomValues(values);
  return values[0] ?? 0;
}

function framed(parts: readonly string[]): string {
  return parts.map((part) => `${part.length}:${part}`).join("|");
}

function hasStrongOtpSecret(env: Bindings): boolean {
  return env.OTP_HMAC_SECRET.trim().length >= 32;
}

function productionEmailIsConfigured(env: Bindings): boolean {
  if (env.ENVIRONMENT !== "production") return true;
  return Boolean(env.RESEND_API_KEY?.trim() && env.EMAIL_FROM?.trim());
}

function periodStart(now: number, periodSeconds: number): number {
  return Math.floor(now / periodSeconds) * periodSeconds;
}

function changed(result: D1Result<unknown>): boolean {
  return Number(result.meta.changes ?? 0) === 1;
}

export function normalizeEmail(email: string): string {
  return email.trim().normalize("NFKC").toLowerCase();
}

/** Generates an unbiased, zero-padded eight digit code with Web Crypto. */
export function generateOtpCode(
  randomUint32: RandomUint32 = secureRandomUint32,
): string {
  const range = 10 ** OTP_CODE_LENGTH;
  const uint32Range = 0x1_0000_0000;
  const unbiasedLimit = Math.floor(uint32Range / range) * range;

  let value: number;
  do {
    value = randomUint32();
    if (!Number.isInteger(value) || value < 0 || value >= uint32Range) {
      throw new TypeError("randomUint32 must return an unsigned 32-bit integer");
    }
  } while (value >= unbiasedLimit);

  return String(value % range).padStart(OTP_CODE_LENGTH, "0");
}

export function otpMacPayload(
  challengeId: string,
  email: string,
  code: string,
): string {
  return framed(["otp", "v1", challengeId, normalizeEmail(email), code]);
}

export function ticketMacPayload(
  challengeId: string,
  email: string,
  verificationTicket: string,
): string {
  return framed([
    "email-verification-ticket",
    "v1",
    challengeId,
    normalizeEmail(email),
    verificationTicket,
  ]);
}

export async function hashOtpCode(
  secret: string,
  challengeId: string,
  email: string,
  code: string,
): Promise<string> {
  return hmacSha256(secret, otpMacPayload(challengeId, email, code));
}

export async function hashVerificationTicket(
  secret: string,
  challengeId: string,
  email: string,
  verificationTicket: string,
): Promise<string> {
  return hmacSha256(
    secret,
    ticketMacPayload(challengeId, email, verificationTicket),
  );
}

async function registrationIsFrozen(db: D1Database): Promise<boolean> {
  const row = await db
    .prepare(
      "SELECT value_json FROM site_settings WHERE key = 'registration_frozen'",
    )
    .first<{ value_json: string }>();
  if (!row) return true;

  try {
    return JSON.parse(row.value_json) !== false;
  } catch {
    return true;
  }
}

async function emailIsEligible(
  db: D1Database,
  email: string,
  purpose: OtpPurpose,
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT u.status
       FROM user_emails ue
       JOIN users u ON u.id = ue.user_id
       WHERE ue.email_normalized = ?1
       LIMIT 1`,
    )
    .bind(email)
    .first<{ status: string }>();

  if (purpose === "register") return row === null;
  if (purpose === "login") {
    return row?.status === "active" || row?.status === "silenced";
  }
  return row !== null && row.status !== "deleted";
}

async function latestVerification(
  db: D1Database,
  email: string,
  purpose: OtpPurpose,
  since: number,
): Promise<LatestVerificationRow | null> {
  return db
    .prepare(
      `SELECT created_at, last_sent_at, resend_count
       FROM email_verifications
       WHERE email_normalized = ?1
         AND purpose = ?2
         AND created_at >= ?3
       ORDER BY created_at DESC
       LIMIT 1`,
    )
    .bind(email, purpose, since)
    .first<LatestVerificationRow>();
}

async function consumeRateLimit(
  db: D1Database,
  keyHash: string,
  action: string,
  start: number,
  expiresAt: number,
  limit: number,
): Promise<boolean> {
  const row = await db
    .prepare(
      `INSERT INTO rate_limit_buckets(
         key_hash, action, period_start, count, expires_at
       ) VALUES (?1, ?2, ?3, 1, ?4)
       ON CONFLICT(key_hash, action, period_start) DO UPDATE SET
         count = rate_limit_buckets.count + 1,
         expires_at = excluded.expires_at
       WHERE rate_limit_buckets.count < ?5
       RETURNING count`,
    )
    .bind(keyHash, action, start, expiresAt, limit)
    .first<{ count: number }>();
  return row !== null;
}

async function acquireResendCooldown(
  db: D1Database,
  keyHash: string,
  now: number,
): Promise<boolean> {
  const row = await db
    .prepare(
      `INSERT INTO rate_limit_buckets(
         key_hash, action, period_start, count, expires_at
       ) VALUES (?1, 'email_code_cooldown', 0, 1, ?2)
       ON CONFLICT(key_hash, action, period_start) DO UPDATE SET
         count = rate_limit_buckets.count + 1,
         expires_at = excluded.expires_at
       WHERE rate_limit_buckets.expires_at <= ?3
       RETURNING count`,
    )
    .bind(keyHash, now + OTP_RESEND_SECONDS, now)
    .first<{ count: number }>();
  return row !== null;
}

function acceptedWithoutIssuing(now: number): RequestEmailCodeResult {
  return {
    accepted: true,
    challengeId: crypto.randomUUID(),
    expiresAt: now + OTP_TTL_SECONDS,
    issued: false,
  };
}

export async function requestEmailCode(
  env: Bindings,
  input: RequestEmailCodeInput,
): Promise<RequestEmailCodeResult> {
  const now = input.now ?? nowSeconds();
  const email = normalizeEmail(input.email);
  const generic = acceptedWithoutIssuing(now);

  if (!hasStrongOtpSecret(env) || !productionEmailIsConfigured(env)) {
    return generic;
  }
  if (input.purpose === "register" && (await registrationIsFrozen(env.CFORUM_DB))) {
    return generic;
  }

  const latest = await latestVerification(
    env.CFORUM_DB,
    email,
    input.purpose,
    now - DAY_SECONDS,
  );
  const latestSendTime = latest
    ? Math.max(latest.created_at, latest.last_sent_at ?? 0)
    : null;
  if (latestSendTime !== null && now - latestSendTime < OTP_RESEND_SECONDS) {
    return generic;
  }

  if (!(await emailIsEligible(env.CFORUM_DB, email, input.purpose))) {
    return generic;
  }

  const [emailKeyHash, providerKeyHash] = await Promise.all([
    hmacSha256(env.OTP_HMAC_SECRET, framed(["otp-rate", "v1", email])),
    hmacSha256(env.OTP_HMAC_SECRET, framed(["otp-rate", "v1", "provider"])),
  ]);
  const hourStart = periodStart(now, HOUR_SECONDS);
  const dayStart = periodStart(now, DAY_SECONDS);

  // The latest-row check above is a cheap fast path; this bucket is the
  // atomic guard that prevents concurrent requests bypassing the 60s window.
  if (!(await acquireResendCooldown(env.CFORUM_DB, emailKeyHash, now))) {
    return generic;
  }
  if (
    !(await consumeRateLimit(
      env.CFORUM_DB,
      emailKeyHash,
      "email_code_hour",
      hourStart,
      hourStart + HOUR_SECONDS,
      OTP_EMAIL_HOURLY_LIMIT,
    ))
  ) {
    return generic;
  }
  if (
    !(await consumeRateLimit(
      env.CFORUM_DB,
      emailKeyHash,
      "email_code_day",
      dayStart,
      dayStart + DAY_SECONDS,
      OTP_EMAIL_DAILY_LIMIT,
    ))
  ) {
    return generic;
  }
  if (
    !(await consumeRateLimit(
      env.CFORUM_DB,
      providerKeyHash,
      "email_provider_day",
      dayStart,
      dayStart + DAY_SECONDS,
      OTP_PROVIDER_DAILY_LIMIT,
    ))
  ) {
    return generic;
  }

  const challengeId = crypto.randomUUID();
  const verificationId = crypto.randomUUID();
  const code = generateOtpCode();
  const codeHash = await hashOtpCode(
    env.OTP_HMAC_SECRET,
    challengeId,
    email,
    code,
  );
  const idempotencyKey = `email-verification:${challengeId}`;
  const expiresAt = now + OTP_TTL_SECONDS;
  const resendCount = latest ? Math.max(0, latest.resend_count) + 1 : 0;

  const batch = await env.CFORUM_DB.batch([
    env.CFORUM_DB.prepare(
      `UPDATE email_verifications
       SET status = 'invalidated'
       WHERE email_normalized = ?1
         AND purpose = ?2
         AND consumed_at IS NULL
         AND status IN ('pending', 'queued', 'sent', 'verified')`,
    ).bind(email, input.purpose),
    env.CFORUM_DB.prepare(
      `INSERT INTO email_verifications(
         id, challenge_id, email_normalized, code_hash, purpose, status,
         attempt_count, resend_count, idempotency_key, created_at, expires_at
       ) VALUES (
         ?1, ?2, ?3, ?4, ?5, 'pending', 0, ?6, ?7, ?8, ?9
       )`,
    ).bind(
      verificationId,
      challengeId,
      email,
      codeHash,
      input.purpose,
      resendCount,
      idempotencyKey,
      now,
      expiresAt,
    ),
  ]);
  if (!changed(batch[1])) throw new Error("email_verification_insert_failed");

  try {
    await env.EMAIL_QUEUE.send({
      idempotencyKey,
      kind: "verification",
      recipient: email,
      payload: { code, challengeId, purpose: input.purpose },
    });
  } catch {
    await env.CFORUM_DB.prepare(
      `UPDATE email_verifications
       SET status = 'failed'
       WHERE id = ?1 AND status = 'pending'`,
    )
      .bind(verificationId)
      .run()
      .catch(() => undefined);
    return generic;
  }

  await env.CFORUM_DB.prepare(
    `UPDATE email_verifications
     SET status = 'queued', last_sent_at = ?2
     WHERE id = ?1 AND status = 'pending'`,
  )
    .bind(verificationId, now)
    .run()
    .catch(() => undefined);

  return {
    accepted: true,
    challengeId,
    expiresAt,
    issued: true,
  };
}

export async function verifyEmailCode(
  env: Bindings,
  input: {
    challengeId: string;
    email: string;
    code: string;
    now?: number;
  },
): Promise<VerifyEmailCodeResult> {
  if (!hasStrongOtpSecret(env)) return { verified: false };

  const now = input.now ?? nowSeconds();
  const email = normalizeEmail(input.email);
  const row = await env.CFORUM_DB.prepare(
    `SELECT
       id, challenge_id, email_normalized, code_hash, purpose, status,
       attempt_count, expires_at, consumed_at
     FROM email_verifications
     WHERE challenge_id = ?1 AND email_normalized = ?2
     LIMIT 1`,
  )
    .bind(input.challengeId, email)
    .first<VerificationRow>();

  if (!row) return { verified: false };
  if (row.expires_at <= now) {
    await env.CFORUM_DB.prepare(
      `UPDATE email_verifications
       SET status = 'expired'
       WHERE id = ?1 AND status IN ('pending', 'queued', 'sent')`,
    )
      .bind(row.id)
      .run();
    return { verified: false };
  }
  if (
    !ACTIVE_CODE_STATUSES.includes(
      row.status as (typeof ACTIVE_CODE_STATUSES)[number],
    ) ||
    row.attempt_count >= OTP_MAX_ATTEMPTS
  ) {
    return { verified: false };
  }

  const candidateHash = await hashOtpCode(
    env.OTP_HMAC_SECRET,
    row.challenge_id,
    email,
    input.code,
  );
  if (!timingSafeEqual(candidateHash, row.code_hash)) {
    await env.CFORUM_DB.prepare(
      `UPDATE email_verifications
       SET
         attempt_count = attempt_count + 1,
         status = CASE
           WHEN attempt_count + 1 >= ?2 THEN 'failed'
           ELSE status
         END
       WHERE id = ?1
         AND status IN ('pending', 'queued', 'sent')
         AND expires_at > ?3
         AND attempt_count < ?2`,
    )
      .bind(row.id, OTP_MAX_ATTEMPTS, now)
      .run();
    return { verified: false };
  }

  const verificationTicket = randomToken(32);
  const ticketHash = await hashVerificationTicket(
    env.OTP_HMAC_SECRET,
    row.challenge_id,
    email,
    verificationTicket,
  );
  const ticketExpiresAt = now + OTP_TTL_SECONDS;
  const result = await env.CFORUM_DB.prepare(
    `UPDATE email_verifications
     SET
       code_hash = ?2,
       status = 'verified',
       expires_at = ?3,
       consumed_at = NULL
     WHERE id = ?1
       AND code_hash = ?4
       AND status IN ('pending', 'queued', 'sent')
       AND expires_at > ?5
       AND attempt_count < ?6`,
  )
    .bind(
      row.id,
      ticketHash,
      ticketExpiresAt,
      row.code_hash,
      now,
      OTP_MAX_ATTEMPTS,
    )
    .run();
  if (!changed(result)) return { verified: false };

  return {
    verified: true,
    challengeId: row.challenge_id,
    email,
    purpose: row.purpose,
    verificationTicket,
    expiresAt: ticketExpiresAt,
  };
}

/**
 * Atomically consumes a ticket returned by verifyEmailCode. Registration,
 * recovery, and fallback-login routes must call this in their commit path.
 */
export async function consumeVerificationTicket(
  env: Bindings,
  input: ConsumeVerificationTicketInput,
): Promise<boolean> {
  if (!hasStrongOtpSecret(env)) return false;

  const now = input.now ?? nowSeconds();
  const email = normalizeEmail(input.email);
  const expectedHash = await hashVerificationTicket(
    env.OTP_HMAC_SECRET,
    input.challengeId,
    email,
    input.verificationTicket,
  );
  const row = await env.CFORUM_DB.prepare(
    `SELECT code_hash
     FROM email_verifications
     WHERE challenge_id = ?1
       AND email_normalized = ?2
       AND purpose = ?3
       AND status = 'verified'
       AND consumed_at IS NULL
       AND expires_at > ?4
     LIMIT 1`,
  )
    .bind(input.challengeId, email, input.purpose, now)
    .first<{ code_hash: string }>();
  if (!row || !timingSafeEqual(row.code_hash, expectedHash)) return false;

  const result = await env.CFORUM_DB.prepare(
    `UPDATE email_verifications
     SET consumed_at = ?4
     WHERE challenge_id = ?1
       AND email_normalized = ?2
       AND purpose = ?3
       AND code_hash = ?5
       AND status = 'verified'
       AND consumed_at IS NULL
       AND expires_at > ?4`,
  )
    .bind(input.challengeId, email, input.purpose, now, expectedHash)
    .run();
  return changed(result);
}
