import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hashVerificationTicket } from "@/worker/auth/otp";
import { guestViewer, type RequestIdentity } from "@/worker/auth/session";
import type { AppEnv, Bindings } from "@/worker/env";
import authRoutes from "@/worker/routes/auth";

interface FakeStatement {
  sql: string;
  bindings: unknown[];
  bind(...values: unknown[]): FakeStatement;
  first<T>(): Promise<T | null>;
}

const OTP_SECRET = "otp-secret".repeat(4);

function bindings(database: D1Database): Bindings {
  return {
    CFORUM_DB: database,
    PUBLIC_MEDIA: {} as R2Bucket,
    PRIVATE_MEDIA: {} as R2Bucket,
    EMAIL_QUEUE: {} as Queue,
    ASSETS: {} as Fetcher,
    ENVIRONMENT: "development",
    APP_ORIGIN: "https://forum.example.com",
    PRIVATE_MEDIA_BUCKET_NAME: "private",
    TURNSTILE_SITE_KEY: "site-key",
    TURNSTILE_SECRET: "turnstile-secret",
    SESSION_HMAC_SECRET: "session-secret".repeat(4),
    OTP_HMAC_SECRET: OTP_SECRET,
    INVITE_HMAC_SECRET: "invite-secret".repeat(4),
    WEBAUTHN_CHALLENGE_SECRET: "challenge-secret".repeat(4),
    BOOTSTRAP_ADMIN_SECRET: "bootstrap-secret".repeat(4),
  };
}

function testApp() {
  const app = new Hono<AppEnv>();
  app.use("*", async (context, next) => {
    const identity: RequestIdentity = { viewer: guestViewer(), session: null };
    context.set("requestId", "request-1");
    context.set("identity", identity);
    await next();
  });
  app.route("/", authRoutes);
  return app;
}

function postRegister(body: unknown, database: D1Database) {
  return testApp().request(
    "https://forum.example.com/register",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
    bindings(database),
  );
}

function stubSuccessfulTurnstile() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({
        success: true,
        action: "registration_submit",
        hostname: "forum.example.com",
      }),
    ),
  );
}

function registrationBody(overrides: Record<string, unknown> = {}) {
  return {
    email: "new-member@example.com",
    challengeId: crypto.randomUUID(),
    verificationTicket: "verification-ticket".repeat(3),
    username: "new_member",
    displayName: "新成员",
    turnstileToken: "turnstile-token",
    ...overrides,
  };
}

function settingsDatabase(
  overrides: Partial<Record<string, unknown>>,
): D1Database {
  const values: Record<string, unknown> = {
    registration_mode: "open",
    registration_frozen: false,
    invite_requires_approval: false,
    disabled_email_domains: [],
    ...overrides,
  };
  return {
    prepare(sql: string) {
      if (!sql.includes("FROM site_settings")) {
        throw new Error(`database should fail closed before query: ${sql}`);
      }
      const statement: FakeStatement = {
        sql,
        bindings: [],
        bind(...bindings: unknown[]) {
          statement.bindings = bindings;
          return statement;
        },
        async first<T>() {
          const key = String(statement.bindings[0]);
          if (!(key in values)) return null;
          return { value_json: JSON.stringify(values[key]) } as T;
        },
      };
      return statement as unknown as D1PreparedStatement;
    },
  } as unknown as D1Database;
}

function inviteRegistrationDatabase(
  expectedTicketHash: string,
  capturedBatches: FakeStatement[][],
  inviteOverrides: Partial<{
    max_uses: number;
    used_count: number;
    expires_at: number | null;
    revoked_at: number | null;
  }> = {},
): D1Database {
  const settings: Record<string, unknown> = {
    registration_mode: "invite_only",
    registration_frozen: false,
    invite_requires_approval: false,
    disabled_email_domains: [],
  };
  return {
    prepare(sql: string) {
      const statement: FakeStatement = {
        sql,
        bindings: [],
        bind(...bindings: unknown[]) {
          statement.bindings = bindings;
          return statement;
        },
        async first<T>() {
          if (sql.includes("FROM site_settings")) {
            const key = String(statement.bindings[0]);
            return { value_json: JSON.stringify(settings[key]) } as T;
          }
          if (sql.includes("FROM email_verifications")) {
            return { code_hash: expectedTicketHash } as T;
          }
          if (sql.includes("FROM invites")) {
            return {
              id: "invite-1",
              email_hash: null,
              allowed_domain: null,
              max_uses: 1,
              used_count: 0,
              expires_at: null,
              revoked_at: null,
              auto_group_id: null,
              ...inviteOverrides,
            } as T;
          }
          throw new Error(`unexpected first query: ${sql}`);
        },
      };
      return statement as unknown as D1PreparedStatement;
    },
    async batch(statements: D1PreparedStatement[]) {
      capturedBatches.push(statements as unknown as FakeStatement[]);
      return statements.map(() => ({
        success: true,
        results: [],
        meta: { changes: 1 },
      })) as unknown as D1Result[];
    },
  } as unknown as D1Database;
}

afterEach(() => vi.unstubAllGlobals());

describe("registration setting integrity", () => {
  it.each([
    ["unknown registration mode", { registration_mode: "closed" }],
    ["non-boolean frozen flag", { registration_frozen: "false" }],
    ["missing approval flag", { invite_requires_approval: undefined }],
    ["non-string disabled domain", { disabled_email_domains: [123] }],
  ])("fails closed for %s", async (_name, overrides) => {
    stubSuccessfulTurnstile();
    const response = await postRegister(
      registrationBody(),
      settingsDatabase(overrides),
    );
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: { code: "REGISTRATION_NOT_AVAILABLE" },
    });
  });
});

describe("invite-only registration guards", () => {
  it("requires both OTP consumption and the invite reservation before user creation", async () => {
    stubSuccessfulTurnstile();
    const body = registrationBody({
      inviteToken: "single-use-invite-token",
    });
    const expectedTicketHash = await hashVerificationTicket(
      OTP_SECRET,
      String(body.challengeId),
      String(body.email),
      String(body.verificationTicket),
    );
    const captured: FakeStatement[][] = [];
    const response = await postRegister(
      body,
      inviteRegistrationDatabase(expectedTicketHash, captured),
    );
    expect(response.status).toBe(201);
    expect(captured).toHaveLength(1);
    const batch = captured[0];
    expect(batch?.[0]?.sql).toContain("UPDATE email_verifications");
    expect(batch?.[1]?.sql).toContain("UPDATE invites");
    expect(batch?.[1]?.sql).toContain("AND changes() = 1");
    expect(batch?.[2]?.sql).toContain("INSERT INTO users");
    expect(batch?.[2]?.sql).toContain("WHERE changes() = 1");
  });

  it("rejects a revoked invitation without consuming the verified email ticket", async () => {
    stubSuccessfulTurnstile();
    const body = registrationBody({
      inviteToken: "revoked-invite-token-value",
    });
    const expectedTicketHash = await hashVerificationTicket(
      OTP_SECRET,
      String(body.challengeId),
      String(body.email),
      String(body.verificationTicket),
    );
    const captured: FakeStatement[][] = [];
    const response = await postRegister(
      body,
      inviteRegistrationDatabase(expectedTicketHash, captured, {
        revoked_at: Math.floor(Date.now() / 1_000) - 1,
      }),
    );
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: { code: "INVITATION_INVALID" },
    });
    expect(captured).toHaveLength(0);
  });
});
