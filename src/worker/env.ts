export interface EmailQueueMessage {
  idempotencyKey: string;
  kind:
    | "verification"
    | "registration_decision"
    | "security_alert"
    | "level_change";
  recipient: string;
  payload: Record<string, string>;
}

export interface Bindings {
  CFORUM_DB: D1Database;
  PUBLIC_MEDIA: R2Bucket;
  PRIVATE_MEDIA: R2Bucket;
  EMAIL_QUEUE: Queue<EmailQueueMessage>;
  ASSETS: Fetcher;
  ENVIRONMENT: "development" | "staging" | "production";
  APP_ORIGIN: string;
  PRIVATE_MEDIA_BUCKET_NAME: string;
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET?: string;
  SESSION_HMAC_SECRET: string;
  OTP_HMAC_SECRET: string;
  INVITE_HMAC_SECRET: string;
  WEBAUTHN_CHALLENGE_SECRET: string;
  BOOTSTRAP_ADMIN_SECRET: string;
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  R2_ACCOUNT_ID?: string;
}

export interface AppVariables {
  requestId: string;
  identity: RequestIdentity;
}

export type AppEnv = {
  Bindings: Bindings;
  Variables: AppVariables;
};
import type { RequestIdentity } from "@/worker/auth/session";
