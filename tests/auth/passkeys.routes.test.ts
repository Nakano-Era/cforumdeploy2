import { describe, expect, it } from "vitest";
import type { Bindings } from "@/worker/env";
import {
  hashWebAuthnChallenge,
  issuePasskeyAuthenticationOptions,
} from "@/worker/auth/passkeys";
import passkeyRoutes from "@/worker/routes/passkeys";

interface CapturedWrite {
  sql: string;
  values: unknown[];
}

function capturingDatabase(writes: CapturedWrite[]): D1Database {
  return {
    prepare(sql: string) {
      let values: unknown[] = [];
      const statement = {
        bind(...nextValues: unknown[]) {
          values = nextValues;
          return statement;
        },
        async run() {
          writes.push({ sql, values });
          return {
            success: true,
            results: [],
            meta: { changes: 1 },
          };
        },
      };
      return statement;
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
    CFORUM_DB: emptyDatabase(),
    ENVIRONMENT: "production",
    APP_ORIGIN: "https://forum.example.com",
    SESSION_HMAC_SECRET: "session-secret".repeat(4),
    OTP_HMAC_SECRET: "otp-secret".repeat(4),
    INVITE_HMAC_SECRET: "invite-secret".repeat(4),
    WEBAUTHN_CHALLENGE_SECRET: "webauthn-secret".repeat(3),
    BOOTSTRAP_ADMIN_SECRET: "bootstrap-secret".repeat(3),
    PUBLIC_MEDIA: {} as R2Bucket,
    PRIVATE_MEDIA: {} as R2Bucket,
    EMAIL_QUEUE: {} as Queue<never>,
    ASSETS: {} as Fetcher,
    ...overrides,
  } as Bindings;
}

describe("passkey routes", () => {
  it("stores only the HMAC of a discoverable authentication challenge", async () => {
    const writes: CapturedWrite[] = [];
    const env = bindings({ CFORUM_DB: capturingDatabase(writes) });
    const result = await issuePasskeyAuthenticationOptions(env);

    expect(result.options.allowCredentials).toBeUndefined();
    expect(result.options.userVerification).toBe("required");
    expect(result.expiresInSeconds).toBe(300);
    expect(writes).toHaveLength(1);
    expect(writes[0]?.sql).toContain("INSERT INTO webauthn_challenges");
    expect(writes[0]?.values).not.toContain(result.options.challenge);
    await expect(
      hashWebAuthnChallenge(env.WEBAUTHN_CHALLENGE_SECRET, {
        challengeId: result.challengeId,
        purpose: "authentication",
        userId: null,
        challenge: result.options.challenge,
      }),
    ).resolves.toBe(writes[0]?.values[1]);
  });

  it("rejects passkey registration without an authenticated session", async () => {
    const response = await passkeyRoutes.request(
      "https://forum.example.com/passkeys/register/options",
      { method: "POST" },
      bindings(),
    );
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: { code: "AUTHENTICATION_REQUIRED" },
    });
  });

  it("rejects malformed authentication responses before database access", async () => {
    const response = await passkeyRoutes.request(
      "https://forum.example.com/passkeys/authenticate/verify",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          challengeId: crypto.randomUUID(),
          response: { id: "credential-only" },
        }),
      },
      bindings(),
    );
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "INVALID_INPUT" },
    });
  });

  it("uses one authentication error for an unknown challenge", async () => {
    const response = await passkeyRoutes.request(
      "https://forum.example.com/passkeys/authenticate/verify",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          challengeId: crypto.randomUUID(),
          response: {
            id: "credential-id",
            rawId: "credential-id",
            response: {
              clientDataJSON: "Y2xpZW50",
              authenticatorData: "YXV0aGVudGljYXRvcg",
              signature: "c2lnbmF0dXJl",
              userHandle: "dXNlci0x",
            },
            clientExtensionResults: {},
            type: "public-key",
          },
        }),
      },
      bindings(),
    );
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: { code: "INVALID_PASSKEY_AUTHENTICATION" },
    });
  });
});
