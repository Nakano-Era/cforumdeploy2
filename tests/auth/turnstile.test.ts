import { describe, expect, it, vi } from "vitest";
import {
  EMAIL_REQUEST_TURNSTILE_ACTION,
  expectedTurnstileHostname,
  verifyTurnstileToken,
} from "@/worker/security/turnstile";

const env = {
  APP_ORIGIN: "https://Forum.Example.com",
  TURNSTILE_SECRET: "turnstile-secret",
};

describe("Turnstile Siteverify", () => {
  it("derives and normalizes the expected hostname", () => {
    expect(expectedTurnstileHostname("https://Forum.Example.com:8443/path")).toBe(
      "forum.example.com",
    );
    expect(expectedTurnstileHostname("not an origin")).toBeNull();
  });

  it("requires success, the expected action, and the expected hostname", async () => {
    const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
      const body = init?.body as URLSearchParams;
      expect(body.get("secret")).toBe("turnstile-secret");
      expect(body.get("response")).toBe("client-token");
      expect(body.get("remoteip")).toBe("203.0.113.7");
      return Response.json({
        success: true,
        action: EMAIL_REQUEST_TURNSTILE_ACTION,
        hostname: "forum.example.com",
      });
    });

    await expect(
      verifyTurnstileToken(env, {
        token: "client-token",
        expectedAction: EMAIL_REQUEST_TURNSTILE_ACTION,
        remoteIp: "203.0.113.7",
        fetcher,
      }),
    ).resolves.toBe(true);
  });

  it("fails closed on action, hostname, configuration, or network errors", async () => {
    const wrongAction = vi.fn<typeof fetch>(async () =>
      Response.json({
        success: true,
        action: "different_action",
        hostname: "forum.example.com",
      }),
    );
    await expect(
      verifyTurnstileToken(env, {
        token: "token",
        expectedAction: EMAIL_REQUEST_TURNSTILE_ACTION,
        fetcher: wrongAction,
      }),
    ).resolves.toBe(false);

    const networkFailure = vi.fn<typeof fetch>(async () => {
      throw new Error("network unavailable");
    });
    await expect(
      verifyTurnstileToken(env, {
        token: "token",
        expectedAction: EMAIL_REQUEST_TURNSTILE_ACTION,
        fetcher: networkFailure,
      }),
    ).resolves.toBe(false);
    await expect(
      verifyTurnstileToken(
        { APP_ORIGIN: env.APP_ORIGIN, TURNSTILE_SECRET: undefined },
        {
          token: "token",
          expectedAction: EMAIL_REQUEST_TURNSTILE_ACTION,
          fetcher: wrongAction,
        },
      ),
    ).resolves.toBe(false);
  });
});
