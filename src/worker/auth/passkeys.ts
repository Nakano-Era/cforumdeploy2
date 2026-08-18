import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import type { UserRole, UserStatus } from "@/shared/domain";
import {
  prepareSession,
  type PreparedSession,
} from "@/worker/auth/session";
import type { AppEnv } from "@/worker/env";
import {
  hmacSha256,
  nowSeconds,
  timingSafeEqual,
} from "@/worker/security/crypto";
import { avatarUrl } from "@/worker/media/avatar-url";

export const WEBAUTHN_CHALLENGE_TTL_SECONDS = 5 * 60;
export const WEBAUTHN_OPERATION_TIMEOUT_MS =
  WEBAUTHN_CHALLENGE_TTL_SECONDS * 1_000;

const WEBAUTHN_RP_NAME = "CForum";
const encoder = new TextEncoder();
const allowedTransports = new Set<AuthenticatorTransportFuture>([
  "ble",
  "cable",
  "hybrid",
  "internal",
  "nfc",
  "smart-card",
  "usb",
]);

type PasskeyBindings = AppEnv["Bindings"];
export type WebAuthnPurpose = "registration" | "authentication";
export type PasskeyFailureKind =
  | "misconfigured"
  | "forbidden"
  | "invalid_challenge"
  | "registration_failed"
  | "invalid_authentication";

export class PasskeyFlowError extends Error {
  readonly name = "PasskeyFlowError";

  constructor(readonly kind: PasskeyFailureKind) {
    super(kind);
  }
}

export interface WebAuthnConfig {
  origin: string;
  rpID: string;
  rpName: string;
}

export interface StoredWebAuthnChallenge {
  id: string;
  user_id: string | null;
  purpose: WebAuthnPurpose;
  challenge_hash: string;
  created_at: number;
  expires_at: number;
  consumed_at: number | null;
}

export interface IssuedPasskeyOptions<TOptions> {
  challengeId: string;
  options: TOptions;
  expiresInSeconds: number;
}

export interface RegisteredPasskey {
  id: string;
  credentialId: string;
  label: string | null;
  createdAt: number;
}

export interface AuthenticatedPasskeyUser {
  id: string;
  username: string;
  displayName: string;
  trustLevel: number;
  role: UserRole;
  status: "active" | "silenced";
  avatarUrl: string | null;
}

export interface PreparedPasskeyAuthentication {
  preparedSession: PreparedSession;
  user: AuthenticatedPasskeyUser;
}

interface RegistrationUserRow {
  id: string;
  username: string;
  display_name: string;
  status: UserStatus;
  avatar_upload_id: string | null;
}

interface PasskeyRow {
  id: string;
  user_id: string;
  credential_id: string;
  public_key: unknown;
  counter: number;
  device_type: string;
  backed_up: number;
  transports_json: string;
  username: string;
  display_name: string;
  trust_level: number;
  role: UserRole;
  status: UserStatus;
  avatar_upload_id: string | null;
}

function misconfigured(): never {
  throw new PasskeyFlowError("misconfigured");
}

function assertChallengeSecret(secret: string): void {
  if (secret.trim().length < 32) misconfigured();
}

export function resolveWebAuthnConfig(
  env: Pick<PasskeyBindings, "APP_ORIGIN" | "ENVIRONMENT">,
): WebAuthnConfig {
  let url: URL;
  try {
    url = new URL(env.APP_ORIGIN.trim());
  } catch {
    return misconfigured();
  }

  if (
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    return misconfigured();
  }

  const hostname = url.hostname.toLowerCase();
  const developmentHost =
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]";
  const protocolAllowed =
    url.protocol === "https:" ||
    (env.ENVIRONMENT === "development" &&
      url.protocol === "http:" &&
      developmentHost);
  if (!protocolAllowed || !hostname) return misconfigured();

  return {
    origin: url.origin,
    rpID: hostname,
    rpName: WEBAUTHN_RP_NAME,
  };
}

export async function hashWebAuthnChallenge(
  secret: string,
  input: {
    challengeId: string;
    purpose: WebAuthnPurpose;
    userId: string | null;
    challenge: string;
  },
): Promise<string> {
  assertChallengeSecret(secret);
  return hmacSha256(
    secret,
    JSON.stringify([
      "cforum:webauthn-challenge:v1",
      input.challengeId,
      input.purpose,
      input.userId,
      input.challenge,
    ]),
  );
}

export async function webAuthnChallengeMatches(
  secret: string,
  storedHash: string,
  input: {
    challengeId: string;
    purpose: WebAuthnPurpose;
    userId: string | null;
    challenge: string;
  },
): Promise<boolean> {
  const candidate = await hashWebAuthnChallenge(secret, input);
  return timingSafeEqual(candidate, storedHash);
}

export function isWebAuthnChallengeUsable(
  challenge: StoredWebAuthnChallenge,
  expected: {
    id: string;
    purpose: WebAuthnPurpose;
    userId: string | null;
    now: number;
  },
): boolean {
  return (
    challenge.id === expected.id &&
    challenge.purpose === expected.purpose &&
    challenge.user_id === expected.userId &&
    challenge.consumed_at === null &&
    challenge.created_at <= expected.now &&
    challenge.expires_at > expected.now
  );
}

export function isPasskeyAccountStatusAllowed(status: string): boolean {
  return status === "active" || status === "silenced";
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

export function encodePasskeyUserHandle(userId: string): string {
  return toBase64Url(encoder.encode(userId));
}

export function passkeyUserHandleMatches(
  userHandle: string | undefined,
  userId: string,
): boolean {
  return Boolean(
    userHandle && timingSafeEqual(userHandle, encodePasskeyUserHandle(userId)),
  );
}

export function parsePasskeyTransports(
  transportsJson: string,
): AuthenticatorTransportFuture[] {
  let value: unknown;
  try {
    value = JSON.parse(transportsJson);
  } catch {
    return [];
  }
  if (!Array.isArray(value)) return [];

  const transports: AuthenticatorTransportFuture[] = [];
  for (const item of value) {
    if (
      typeof item === "string" &&
      allowedTransports.has(item as AuthenticatorTransportFuture) &&
      !transports.includes(item as AuthenticatorTransportFuture)
    ) {
      transports.push(item as AuthenticatorTransportFuture);
    }
  }
  return transports;
}

export function storedPasskeyPublicKey(
  value: unknown,
): Uint8Array<ArrayBuffer> {
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value.slice(0));
  }
  if (ArrayBuffer.isView(value)) {
    const source = new Uint8Array(
      value.buffer,
      value.byteOffset,
      value.byteLength,
    );
    const copy = new Uint8Array(source.byteLength);
    copy.set(source);
    return copy;
  }
  if (
    Array.isArray(value) &&
    value.every(
      (item) => Number.isInteger(item) && Number(item) >= 0 && Number(item) <= 255,
    )
  ) {
    return Uint8Array.from(value as number[]);
  }
  throw new PasskeyFlowError("invalid_authentication");
}

function normalizedTransports(
  value: readonly AuthenticatorTransportFuture[] | undefined,
): AuthenticatorTransportFuture[] {
  return parsePasskeyTransports(JSON.stringify(value ?? []));
}

async function getChallenge(
  database: D1Database,
  challengeId: string,
): Promise<StoredWebAuthnChallenge | null> {
  return database
    .prepare(
      `SELECT
         id, user_id, purpose, challenge_hash, created_at, expires_at, consumed_at
       FROM webauthn_challenges
       WHERE id = ?1
       LIMIT 1`,
    )
    .bind(challengeId)
    .first<StoredWebAuthnChallenge>();
}

export async function issuePasskeyRegistrationOptions(
  env: PasskeyBindings,
  userId: string,
): Promise<IssuedPasskeyOptions<Awaited<ReturnType<typeof generateRegistrationOptions>>>> {
  const config = resolveWebAuthnConfig(env);
  assertChallengeSecret(env.WEBAUTHN_CHALLENGE_SECRET);
  const user = await env.CFORUM_DB.prepare(
    `SELECT id, username, display_name, status
     FROM users
     WHERE id = ?1 AND status IN ('active', 'silenced')
     LIMIT 1`,
  )
    .bind(userId)
    .first<RegistrationUserRow>();
  if (!user || !isPasskeyAccountStatusAllowed(user.status)) {
    throw new PasskeyFlowError("forbidden");
  }

  const existing = await env.CFORUM_DB.prepare(
    `SELECT credential_id, transports_json
     FROM passkeys
     WHERE user_id = ?1
     ORDER BY created_at`,
  )
    .bind(userId)
    .all<{ credential_id: string; transports_json: string }>();
  const options = await generateRegistrationOptions({
    rpName: config.rpName,
    rpID: config.rpID,
    userID: encoder.encode(user.id),
    userName: user.username,
    userDisplayName: user.display_name,
    timeout: WEBAUTHN_OPERATION_TIMEOUT_MS,
    attestationType: "none",
    excludeCredentials: existing.results.map((credential) => ({
      id: credential.credential_id,
      transports: parsePasskeyTransports(credential.transports_json),
    })),
    authenticatorSelection: {
      residentKey: "required",
      requireResidentKey: true,
      userVerification: "required",
    },
  });

  const challengeId = crypto.randomUUID();
  const now = nowSeconds();
  const challengeHash = await hashWebAuthnChallenge(
    env.WEBAUTHN_CHALLENGE_SECRET,
    {
      challengeId,
      purpose: "registration",
      userId,
      challenge: options.challenge,
    },
  );
  const results = await env.CFORUM_DB.batch([
    env.CFORUM_DB.prepare(
      `UPDATE webauthn_challenges
       SET consumed_at = ?2
       WHERE user_id = ?1
         AND purpose = 'registration'
         AND consumed_at IS NULL`,
    ).bind(userId, now),
    env.CFORUM_DB.prepare(
      `INSERT INTO webauthn_challenges(
         id, user_id, purpose, challenge_hash, created_at, expires_at
       ) VALUES (?1, ?2, 'registration', ?3, ?4, ?5)`,
    ).bind(
      challengeId,
      userId,
      challengeHash,
      now,
      now + WEBAUTHN_CHALLENGE_TTL_SECONDS,
    ),
  ]);
  if (Number(results[1]?.meta.changes ?? 0) !== 1) {
    throw new PasskeyFlowError("misconfigured");
  }

  return {
    challengeId,
    options,
    expiresInSeconds: WEBAUTHN_CHALLENGE_TTL_SECONDS,
  };
}

export async function verifyAndRegisterPasskey(
  env: PasskeyBindings,
  input: {
    userId: string;
    challengeId: string;
    response: RegistrationResponseJSON;
    label?: string;
  },
): Promise<RegisteredPasskey> {
  const config = resolveWebAuthnConfig(env);
  assertChallengeSecret(env.WEBAUTHN_CHALLENGE_SECRET);
  const now = nowSeconds();
  const [challenge, user] = await Promise.all([
    getChallenge(env.CFORUM_DB, input.challengeId),
    env.CFORUM_DB.prepare(
      `SELECT id, username, display_name, status
       FROM users
       WHERE id = ?1 AND status IN ('active', 'silenced')
       LIMIT 1`,
    )
      .bind(input.userId)
      .first<RegistrationUserRow>(),
  ]);
  if (!user || !isPasskeyAccountStatusAllowed(user.status)) {
    throw new PasskeyFlowError("forbidden");
  }
  if (
    !challenge ||
    !isWebAuthnChallengeUsable(challenge, {
      id: input.challengeId,
      purpose: "registration",
      userId: input.userId,
      now,
    })
  ) {
    throw new PasskeyFlowError("invalid_challenge");
  }

  let verification: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
  try {
    verification = await verifyRegistrationResponse({
      response: input.response,
      expectedChallenge: (receivedChallenge) =>
        webAuthnChallengeMatches(
          env.WEBAUTHN_CHALLENGE_SECRET,
          challenge.challenge_hash,
          {
            challengeId: challenge.id,
            purpose: "registration",
            userId: input.userId,
            challenge: receivedChallenge,
          },
        ),
      expectedOrigin: config.origin,
      expectedRPID: config.rpID,
      expectedType: "webauthn.create",
      requireUserPresence: true,
      requireUserVerification: true,
    });
  } catch {
    throw new PasskeyFlowError("registration_failed");
  }
  if (!verification.verified || !verification.registrationInfo.userVerified) {
    throw new PasskeyFlowError("registration_failed");
  }

  const consumed = await env.CFORUM_DB.prepare(
    `UPDATE webauthn_challenges
     SET consumed_at = ?4
     WHERE id = ?1
       AND user_id = ?2
       AND purpose = 'registration'
       AND challenge_hash = ?3
       AND consumed_at IS NULL
       AND expires_at > ?4
       AND EXISTS (
         SELECT 1 FROM users
         WHERE id = ?2 AND status IN ('active', 'silenced')
       )`,
  )
    .bind(challenge.id, input.userId, challenge.challenge_hash, now)
    .run();
  if (Number(consumed.meta.changes) !== 1) {
    throw new PasskeyFlowError("invalid_challenge");
  }

  const passkeyId = crypto.randomUUID();
  const { credential, credentialDeviceType, credentialBackedUp } =
    verification.registrationInfo;
  const transports = normalizedTransports(
    credential.transports ?? input.response.response.transports,
  );
  try {
    await env.CFORUM_DB.prepare(
      `INSERT INTO passkeys(
         id, user_id, credential_id, public_key, counter, device_type,
         backed_up, transports_json, label, created_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
    )
      .bind(
        passkeyId,
        input.userId,
        credential.id,
        credential.publicKey.slice().buffer,
        credential.counter,
        credentialDeviceType,
        credentialBackedUp ? 1 : 0,
        JSON.stringify(transports),
        input.label ?? null,
        now,
      )
      .run();
  } catch {
    // The challenge remains consumed even if a duplicate credential or storage
    // failure occurs. Retrying must always begin with a fresh ceremony.
    throw new PasskeyFlowError("registration_failed");
  }

  return {
    id: passkeyId,
    credentialId: credential.id,
    label: input.label ?? null,
    createdAt: now,
  };
}

export async function issuePasskeyAuthenticationOptions(
  env: PasskeyBindings,
): Promise<IssuedPasskeyOptions<Awaited<ReturnType<typeof generateAuthenticationOptions>>>> {
  const config = resolveWebAuthnConfig(env);
  assertChallengeSecret(env.WEBAUTHN_CHALLENGE_SECRET);
  const options = await generateAuthenticationOptions({
    rpID: config.rpID,
    timeout: WEBAUTHN_OPERATION_TIMEOUT_MS,
    userVerification: "required",
  });
  const challengeId = crypto.randomUUID();
  const now = nowSeconds();
  const challengeHash = await hashWebAuthnChallenge(
    env.WEBAUTHN_CHALLENGE_SECRET,
    {
      challengeId,
      purpose: "authentication",
      userId: null,
      challenge: options.challenge,
    },
  );
  const inserted = await env.CFORUM_DB.prepare(
    `INSERT INTO webauthn_challenges(
       id, user_id, purpose, challenge_hash, created_at, expires_at
     ) VALUES (?1, NULL, 'authentication', ?2, ?3, ?4)`,
  )
    .bind(
      challengeId,
      challengeHash,
      now,
      now + WEBAUTHN_CHALLENGE_TTL_SECONDS,
    )
    .run();
  if (Number(inserted.meta.changes) !== 1) {
    throw new PasskeyFlowError("misconfigured");
  }

  return {
    challengeId,
    options,
    expiresInSeconds: WEBAUTHN_CHALLENGE_TTL_SECONDS,
  };
}

export async function verifyAndPreparePasskeyAuthentication(
  env: PasskeyBindings,
  input: {
    challengeId: string;
    response: AuthenticationResponseJSON;
  },
): Promise<PreparedPasskeyAuthentication> {
  const config = resolveWebAuthnConfig(env);
  assertChallengeSecret(env.WEBAUTHN_CHALLENGE_SECRET);
  const now = nowSeconds();
  const challenge = await getChallenge(env.CFORUM_DB, input.challengeId);
  if (
    !challenge ||
    !isWebAuthnChallengeUsable(challenge, {
      id: input.challengeId,
      purpose: "authentication",
      userId: null,
      now,
    })
  ) {
    throw new PasskeyFlowError("invalid_authentication");
  }

  const passkey = await env.CFORUM_DB.prepare(
    `SELECT
       p.id, p.user_id, p.credential_id, p.public_key, p.counter,
       p.device_type, p.backed_up, p.transports_json,
       u.username, u.display_name, u.trust_level, u.role, u.status,
       u.avatar_upload_id
     FROM passkeys p
     JOIN users u ON u.id = p.user_id
     WHERE p.credential_id = ?1
       AND u.status IN ('active', 'silenced')
     LIMIT 1`,
  )
    .bind(input.response.id)
    .first<PasskeyRow>();
  if (
    !passkey ||
    !isPasskeyAccountStatusAllowed(passkey.status) ||
    !passkeyUserHandleMatches(input.response.response.userHandle, passkey.user_id)
  ) {
    throw new PasskeyFlowError("invalid_authentication");
  }

  let verification: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
  try {
    verification = await verifyAuthenticationResponse({
      response: input.response,
      expectedChallenge: (receivedChallenge) =>
        webAuthnChallengeMatches(
          env.WEBAUTHN_CHALLENGE_SECRET,
          challenge.challenge_hash,
          {
            challengeId: challenge.id,
            purpose: "authentication",
            userId: null,
            challenge: receivedChallenge,
          },
        ),
      expectedOrigin: config.origin,
      expectedRPID: config.rpID,
      expectedType: "webauthn.get",
      requireUserVerification: true,
      advancedFIDOConfig: { userVerification: "required" },
      credential: {
        id: passkey.credential_id,
        publicKey: storedPasskeyPublicKey(passkey.public_key),
        counter: passkey.counter,
        transports: parsePasskeyTransports(passkey.transports_json),
      },
    });
  } catch {
    throw new PasskeyFlowError("invalid_authentication");
  }
  if (
    !verification.verified ||
    !verification.authenticationInfo.userVerified ||
    verification.authenticationInfo.origin !== config.origin ||
    verification.authenticationInfo.rpID !== config.rpID
  ) {
    throw new PasskeyFlowError("invalid_authentication");
  }

  const preparedSession = await prepareSession(env, passkey.user_id);
  const counterUpdated = await env.CFORUM_DB.prepare(
    `UPDATE passkeys
     SET counter = ?1,
         device_type = ?2,
         backed_up = ?3,
         last_used_at = ?4
     WHERE id = ?5
       AND user_id = ?6
       AND counter = ?7
       AND EXISTS (
         SELECT 1 FROM users
         WHERE id = ?6 AND status IN ('active', 'silenced')
       )`,
  )
    .bind(
      verification.authenticationInfo.newCounter,
      verification.authenticationInfo.credentialDeviceType,
      verification.authenticationInfo.credentialBackedUp ? 1 : 0,
      now,
      passkey.id,
      passkey.user_id,
      passkey.counter,
    )
    .run();
  if (Number(counterUpdated.meta.changes) !== 1) {
    throw new PasskeyFlowError("invalid_authentication");
  }

  // Keep these adjacent: guardedStatement relies on SQLite changes() from the
  // one-time challenge UPDATE, so a concurrent replay cannot create a session.
  const results = await env.CFORUM_DB.batch([
    env.CFORUM_DB.prepare(
      `UPDATE webauthn_challenges
       SET consumed_at = ?4
       WHERE id = ?1
         AND user_id IS NULL
         AND purpose = 'authentication'
         AND challenge_hash = ?2
         AND consumed_at IS NULL
         AND expires_at > ?4
         AND EXISTS (
           SELECT 1 FROM users
           WHERE id = ?3 AND status IN ('active', 'silenced')
         )`,
    ).bind(challenge.id, challenge.challenge_hash, passkey.user_id, now),
    preparedSession.guardedStatement,
  ]);
  if (
    Number(results[0]?.meta.changes ?? 0) !== 1 ||
    Number(results[1]?.meta.changes ?? 0) !== 1
  ) {
    throw new PasskeyFlowError("invalid_authentication");
  }

  return {
    preparedSession,
    user: {
      id: passkey.user_id,
      username: passkey.username,
      displayName: passkey.display_name,
      trustLevel: passkey.trust_level,
      role: passkey.role,
      status: passkey.status as "active" | "silenced",
      avatarUrl: avatarUrl(passkey.avatar_upload_id),
    },
  };
}
