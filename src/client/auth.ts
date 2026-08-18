import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/browser";
import { requestJson } from "./api";
import type { TrustLevel } from "./feed";

export type AuthUserRole = "member" | "moderator" | "admin";
export type AuthUserStatus = "active" | "silenced";
export type EmailAuthPurpose = "login" | "register";

export interface AuthUser {
  id: string;
  username: string;
  displayName: string;
  trustLevel: TrustLevel;
  role: AuthUserRole;
  status?: AuthUserStatus;
  avatarUrl?: string | null;
}

export type AuthSessionResponse =
  | { authenticated: false }
  | { authenticated: true; user: AuthUser };

export interface AuthenticatedResponse {
  user: AuthUser;
  csrfToken: string;
}

export interface PasskeyAuthenticationOptionsResponse {
  challengeId: string;
  options: PublicKeyCredentialRequestOptionsJSON;
  expiresInSeconds: number;
}

export interface PasskeyRegistrationOptionsResponse {
  challengeId: string;
  options: PublicKeyCredentialCreationOptionsJSON;
  expiresInSeconds: number;
}

export interface PasskeyRegistrationResponse {
  passkey: {
    id: string;
    credentialId: string;
    label: string | null;
    createdAt: number;
  };
}

export interface EmailCodeRequestResponse {
  accepted: true;
  challengeId: string;
  expiresInSeconds: number;
  resendAfterSeconds: number;
  message: string;
}

export interface EmailCodeVerificationResponse {
  verified: true;
  challengeId: string;
  email: string;
  purpose: EmailAuthPurpose;
  verificationTicket: string;
  expiresInSeconds: number;
}

export interface RegistrationRequest {
  email: string;
  challengeId: string;
  verificationTicket: string;
  username: string;
  displayName: string;
  inviteToken?: string;
  turnstileToken: string;
}

export interface RegistrationResponse {
  registration: {
    status: "active" | "pending_review";
    passkeySetupRecommended: true;
  };
  user?: AuthUser;
  csrfToken?: string;
}

export async function getAuthSession(
  signal?: AbortSignal,
): Promise<AuthSessionResponse> {
  return requestJson<AuthSessionResponse>("/api/auth/session", {
    method: "GET",
    signal,
  });
}

export async function getPasskeyAuthenticationOptions(): Promise<PasskeyAuthenticationOptionsResponse> {
  return requestJson<PasskeyAuthenticationOptionsResponse>(
    "/api/auth/passkeys/authenticate/options",
    { method: "POST" },
  );
}

export async function verifyPasskeyAuthentication(
  challengeId: string,
  response: AuthenticationResponseJSON,
): Promise<AuthenticatedResponse> {
  return requestJson<AuthenticatedResponse>(
    "/api/auth/passkeys/authenticate/verify",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ challengeId, response }),
    },
  );
}

export async function getPasskeyRegistrationOptions(
  csrfToken: string,
): Promise<PasskeyRegistrationOptionsResponse> {
  return requestJson<PasskeyRegistrationOptionsResponse>(
    "/api/auth/passkeys/register/options",
    {
      method: "POST",
      headers: { "X-CSRF-Token": csrfToken },
    },
  );
}

export async function verifyPasskeyRegistration(
  challengeId: string,
  response: RegistrationResponseJSON,
  csrfToken: string,
  label?: string,
): Promise<PasskeyRegistrationResponse> {
  return requestJson<PasskeyRegistrationResponse>(
    "/api/auth/passkeys/register/verify",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": csrfToken,
      },
      body: JSON.stringify({
        challengeId,
        response,
        ...(label ? { label } : {}),
      }),
    },
  );
}

export async function requestEmailCode(input: {
  email: string;
  purpose: EmailAuthPurpose;
  turnstileToken: string;
}): Promise<EmailCodeRequestResponse> {
  return requestJson<EmailCodeRequestResponse>(
    "/api/auth/email/request-code",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    },
  );
}

export async function verifyEmailCode(input: {
  challengeId: string;
  email: string;
  code: string;
}): Promise<EmailCodeVerificationResponse> {
  return requestJson<EmailCodeVerificationResponse>("/api/auth/email/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

export async function consumeEmailLogin(input: {
  challengeId: string;
  email: string;
  verificationTicket: string;
}): Promise<AuthenticatedResponse> {
  return requestJson<AuthenticatedResponse>(
    "/api/auth/email/consume-login",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    },
  );
}

export async function registerAccount(
  input: RegistrationRequest,
): Promise<RegistrationResponse> {
  return requestJson<RegistrationResponse>("/api/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

/**
 * The session endpoint intentionally does not echo the CSRF secret. The server
 * sets a Strict same-site, non-HttpOnly double-submit cookie, which is copied
 * into memory after session recovery and never written to web storage.
 */
export function readCsrfCookie(): string | null {
  const prefix = "cforum_csrf=";
  for (const item of document.cookie.split(";")) {
    const cookie = item.trim();
    if (cookie.startsWith(prefix)) {
      try {
        return decodeURIComponent(cookie.slice(prefix.length));
      } catch {
        return null;
      }
    }
  }
  return null;
}
