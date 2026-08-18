import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { RequestIdentity } from "@/worker/auth/session";
import type { AppEnv, Bindings } from "@/worker/env";
import profileRoutes from "@/worker/routes/profile";

const UPLOAD_ID = "11111111-1111-4111-8111-111111111111";

function identity(
  status: RequestIdentity["viewer"]["status"] = "active",
): RequestIdentity {
  return {
    viewer: {
      userId: "44444444-4444-4444-8444-444444444444",
      role: "member",
      status,
      trustLevel: 1,
      groupIds: new Set(),
      moderatedCategoryIds: new Set(),
    },
    session: null,
  };
}

function guestIdentity(): RequestIdentity {
  return {
    viewer: {
      userId: null,
      role: "guest",
      status: "guest",
      trustLevel: null,
      groupIds: new Set(),
      moderatedCategoryIds: new Set(),
    },
    session: null,
  };
}

function throwingDatabase(): D1Database {
  return {
    prepare() {
      throw new Error("database must not be touched");
    },
  } as unknown as D1Database;
}

function bindings(): Bindings {
  return {
    CFORUM_DB: throwingDatabase(),
    PRIVATE_MEDIA: {} as R2Bucket,
    PUBLIC_MEDIA: {} as R2Bucket,
  } as unknown as Bindings;
}

function app(requestIdentity: RequestIdentity) {
  const instance = new Hono<AppEnv>();
  instance.use("*", async (context, next) => {
    context.set("identity", requestIdentity);
    context.set("requestId", "request-1");
    await next();
  });
  instance.route("/", profileRoutes);
  return instance;
}

describe("profile avatar routes", () => {
  it.each([
    ["POST", "/profile/avatar"],
    ["DELETE", "/profile/avatar"],
  ])("returns 401 for a guest before account-state checks on %s %s", async (method, path) => {
    const response = await app(guestIdentity()).request(
      `https://forum.example.com${path}`,
      {
        method,
        headers: { "content-type": "application/json" },
        ...(method === "POST" ? { body: JSON.stringify({ uploadId: UPLOAD_ID }) } : {}),
      },
      bindings(),
    );
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: { code: "AUTHENTICATION_REQUIRED" },
    });
  });

  it("strictly validates the bind body before database or R2 access", async () => {
    const response = await app(identity()).request(
      "https://forum.example.com/profile/avatar",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ uploadId: UPLOAD_ID, objectKey: "chosen.png" }),
      },
      bindings(),
    );
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({
      error: { code: "INVALID_UPLOAD_REQUEST" },
    });
  });

  it.each([
    ["POST", "/profile/avatar"],
    ["DELETE", "/profile/avatar"],
  ])("requires an active account for %s %s", async (method, path) => {
    const response = await app(identity("suspended")).request(
      `https://forum.example.com${path}`,
      {
        method,
        headers: { "content-type": "application/json" },
        ...(method === "POST" ? { body: JSON.stringify({ uploadId: UPLOAD_ID }) } : {}),
      },
      bindings(),
    );
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: { code: "ACCOUNT_INACTIVE" },
    });
  });

  it.each(["GET", "HEAD"])("conceals a malformed public avatar URL for %s", async (method) => {
    const response = await app(identity()).request(
      "https://forum.example.com/avatars/not-a-uuid",
      { method },
      bindings(),
    );
    expect(response.status).toBe(404);
    if (method === "GET") {
      await expect(response.json()).resolves.toEqual({
        error: { code: "MEDIA_NOT_FOUND" },
      });
    }
  });
});
