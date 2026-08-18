import { getCookie, setCookie } from "hono/cookie";
import type { Context } from "hono";
import type { TrustLevel, UserRole, UserStatus } from "@/shared/domain";
import type { AppEnv } from "@/worker/env";
import type { ViewerContext } from "@/worker/permissions/policy";
import { hmacSha256, nowSeconds, randomToken } from "@/worker/security/crypto";

export const SESSION_COOKIE = "__Host-cforum_session";
export const DEV_SESSION_COOKIE = "cforum_session";
export const CSRF_COOKIE = "cforum_csrf";
const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

export interface AuthenticatedSession {
  id: string;
  userId: string;
  csrfHash: string;
  expiresAt: number;
}

export interface PreparedSession {
  statement: D1PreparedStatement;
  /** Use immediately after an atomic one-time guard UPDATE in a D1 batch. */
  guardedStatement: D1PreparedStatement;
  sessionToken: string;
  csrfToken: string;
}

export interface RequestIdentity {
  viewer: ViewerContext;
  session: AuthenticatedSession | null;
}

export const guestViewer = (): ViewerContext => ({
  userId: null,
  role: "guest",
  status: "guest",
  trustLevel: null,
  groupIds: new Set(),
  moderatedCategoryIds: new Set(),
});

export function sessionCookieName(
  env: Pick<AppEnv["Bindings"], "ENVIRONMENT">,
): string {
  return env.ENVIRONMENT === "development"
    ? DEV_SESSION_COOKIE
    : SESSION_COOKIE;
}

function asTrustLevel(value: number): TrustLevel {
  if (value < 0 || value > 4 || !Number.isInteger(value)) return 0;
  return value as TrustLevel;
}

export async function readRequestIdentity(
  context: Context<AppEnv>,
): Promise<RequestIdentity> {
  const token = getCookie(context, sessionCookieName(context.env));
  if (!token) return { viewer: guestViewer(), session: null };

  const tokenHash = await hmacSha256(context.env.SESSION_HMAC_SECRET, token);
  const now = nowSeconds();
  const sessionRow = await context.env.CFORUM_DB.prepare(
    `SELECT
       s.id AS session_id,
       s.user_id,
       s.csrf_hash,
       s.expires_at,
       u.role,
       u.status,
       u.trust_level
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ?1
       AND s.revoked_at IS NULL
       AND s.expires_at > ?2
     LIMIT 1`,
  )
    .bind(tokenHash, now)
    .first<{
      session_id: string;
      user_id: string;
      csrf_hash: string;
      expires_at: number;
      role: UserRole;
      status: UserStatus;
      trust_level: number;
    }>();

  if (!sessionRow) return { viewer: guestViewer(), session: null };

  const [groups, scopes] = await context.env.CFORUM_DB.batch([
    context.env.CFORUM_DB.prepare(
      "SELECT group_id FROM group_members WHERE user_id = ?1",
    ).bind(sessionRow.user_id),
    context.env.CFORUM_DB.prepare(
      "SELECT category_id FROM moderator_category_scopes WHERE user_id = ?1",
    ).bind(sessionRow.user_id),
  ]);

  return {
    viewer: {
      userId: sessionRow.user_id,
      role: sessionRow.role,
      status: sessionRow.status,
      trustLevel: asTrustLevel(sessionRow.trust_level),
      groupIds: new Set(
        (groups.results as Array<{ group_id: string }>).map((row) => row.group_id),
      ),
      moderatedCategoryIds: new Set(
        (scopes.results as Array<{ category_id: string }>).map(
          (row) => row.category_id,
        ),
      ),
    },
    session: {
      id: sessionRow.session_id,
      userId: sessionRow.user_id,
      csrfHash: sessionRow.csrf_hash,
      expiresAt: sessionRow.expires_at,
    },
  };
}

export async function prepareSession(
  env: AppEnv["Bindings"],
  userId: string,
): Promise<PreparedSession> {
  if (env.SESSION_HMAC_SECRET.trim().length < 32) {
    throw new Error("session_secret_too_short");
  }
  const sessionToken = randomToken();
  const csrfToken = randomToken();
  const [tokenHash, csrfHash] = await Promise.all([
    hmacSha256(env.SESSION_HMAC_SECRET, sessionToken),
    hmacSha256(env.SESSION_HMAC_SECRET, csrfToken),
  ]);
  const now = nowSeconds();
  const expiresAt = now + SESSION_MAX_AGE_SECONDS;

  return {
    statement: env.CFORUM_DB.prepare(
      `INSERT INTO sessions(
         id, user_id, token_hash, csrf_hash, created_at, last_seen_at, expires_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?5, ?6)`,
    ).bind(crypto.randomUUID(), userId, tokenHash, csrfHash, now, expiresAt),
    guardedStatement: env.CFORUM_DB.prepare(
      `INSERT INTO sessions(
         id, user_id, token_hash, csrf_hash, created_at, last_seen_at, expires_at
       )
       SELECT ?1, ?2, ?3, ?4, ?5, ?5, ?6
       WHERE changes() = 1`,
    ).bind(crypto.randomUUID(), userId, tokenHash, csrfHash, now, expiresAt),
    sessionToken,
    csrfToken,
  };
}

export function setSessionCookies(
  context: Context<AppEnv>,
  prepared: Pick<PreparedSession, "sessionToken" | "csrfToken">,
): void {
  setCookie(context, sessionCookieName(context.env), prepared.sessionToken, {
    httpOnly: true,
    secure: context.env.ENVIRONMENT !== "development",
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
  setCookie(context, CSRF_COOKIE, prepared.csrfToken, {
    httpOnly: false,
    secure: context.env.ENVIRONMENT !== "development",
    sameSite: "Strict",
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
  });

}

export async function createSession(
  context: Context<AppEnv>,
  userId: string,
): Promise<{ statement: D1PreparedStatement; csrfToken: string }> {
  const prepared = await prepareSession(context.env, userId);
  setSessionCookies(context, prepared);
  return { statement: prepared.statement, csrfToken: prepared.csrfToken };
}

export async function verifyCsrf(
  context: Context<AppEnv>,
  session: AuthenticatedSession,
): Promise<boolean> {
  const cookieToken = getCookie(context, CSRF_COOKIE);
  const headerToken = context.req.header("x-csrf-token");
  if (!cookieToken || !headerToken || cookieToken !== headerToken) return false;
  const hash = await hmacSha256(context.env.SESSION_HMAC_SECRET, headerToken);
  return hash === session.csrfHash;
}
