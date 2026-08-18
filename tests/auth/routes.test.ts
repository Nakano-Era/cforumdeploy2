import { afterEach, describe, expect, it, vi } from "vitest";
import type { Bindings } from "@/worker/env";
import authRoutes from "@/worker/routes/auth";
import { EMAIL_REQUEST_TURNSTILE_ACTION } from "@/worker/security/turnstile";

function throwingDatabase(): D1Database {
  return {
    prepare() {
      throw new Error("database should not be accessed");
    },
  } as unknown as D1Database;
}

function emptyDatabase(): D1Database {
  const statement = {
    bind() {
      return statement;
    },
    async first() {
      return null;
    },
  };
  return {
    prepare() {
      return statement;
    },
  } as unknown as D1Database;
}

function bindings(overrides: Partial<Bindings> = {}): Bindings {
  return {
    CFORUM_DB: throwingDatabase(),
    ENVIRONMENT: "production",
    APP_ORIGIN: "https://forum.example.com",
    TURNSTILE_SITE_KEY: "site-key",
    TURNSTILE_SECRET: "turnstile-secret",
    SESSION_HMAC_SECRET: "session-secret".repeat(4),
    OTP_HMAC_SECRET: "otp-secret".repeat(4),
    BOOTSTRAP_ADMIN_SECRET: "bootstrap-secret".repeat(3),
    PUBLIC_MEDIA: {} as R2Bucket,
    PRIVATE_MEDIA: {} as R2Bucket,
    EMAIL_QUEUE: {} as Queue<never>,
    ASSETS: {} as Fetcher,
    ...overrides,
  } as Bindings;
}

function post(path: string, body: unknown, env: Bindings) {
  return authRoutes.request(
    `https://forum.example.com${path}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
    env,
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("email auth routes", () => {
  it("rejects malformed request and verification bodies", async () => {
    const env = bindings();
    const requestResponse = await post(
      "/email/request-code",
      { email: "not-an-email", turnstileToken: "token" },
      env,
    );
    expect(requestResponse.status).toBe(422);

    const verifyResponse = await post(
      "/email/verify",
      {
        challengeId: crypto.randomUUID(),
        email: "user@example.com",
        code: "123",
      },
      env,
    );
    expect(verifyResponse.status).toBe(422);
  });

  it("fails closed when Turnstile rejects the request", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          success: true,
          action: "wrong_action",
          hostname: "forum.example.com",
        }),
      ),
    );
    const response = await post(
      "/email/request-code",
      { email: "user@example.com", turnstileToken: "token" },
      bindings(),
    );
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: { code: "TURNSTILE_FAILED" },
    });
  });

  it("uses the generic anti-enumeration response when production mail is absent", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          success: true,
          action: EMAIL_REQUEST_TURNSTILE_ACTION,
          hostname: "forum.example.com",
        }),
      ),
    );
    const env = bindings({ RESEND_API_KEY: undefined, EMAIL_FROM: undefined });
    const responses = await Promise.all([
      post(
        "/email/request-code",
        { email: "first@example.com", turnstileToken: "token" },
        env,
      ),
      post(
        "/email/request-code",
        { email: "second@example.com", turnstileToken: "token" },
        env,
      ),
    ]);

    for (const response of responses) {
      expect(response.status).toBe(202);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body).toMatchObject({
        accepted: true,
        expiresInSeconds: 600,
        resendAfterSeconds: 60,
        message:
          "If the request is eligible, a verification code will be sent.",
      });
      expect(body.challengeId).toEqual(expect.any(String));
    }
  });

  it("uses one generic verification error for unknown challenges", async () => {
    const response = await post(
      "/email/verify",
      {
        challengeId: crypto.randomUUID(),
        email: "user@example.com",
        code: "12345678",
      },
      bindings({ CFORUM_DB: emptyDatabase() }),
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: { code: "INVALID_OR_EXPIRED_VERIFICATION_CODE" },
    });
  });
});
