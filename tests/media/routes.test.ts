import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { RequestIdentity } from "@/worker/auth/session";
import type { AppEnv, Bindings } from "@/worker/env";
import uploadRoutes from "@/worker/routes/uploads";

const UPLOAD_ID = "11111111-1111-4111-8111-111111111111";
const TOPIC_ID = "22222222-2222-4222-8222-222222222222";
const POST_ID = "33333333-3333-4333-8333-333333333333";

function identity(
  overrides: Partial<RequestIdentity["viewer"]> = {},
): RequestIdentity {
  const viewer = {
    userId: "44444444-4444-4444-8444-444444444444",
    role: "member" as const,
    status: "active" as const,
    trustLevel: 1 as const,
    groupIds: new Set<string>(),
    moderatedCategoryIds: new Set<string>(),
    ...overrides,
  };
  return { viewer, session: null };
}

function throwingDatabase(): D1Database {
  return {
    prepare() {
      throw new Error("database must not be touched for an invalid route input");
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
    context.set("requestId", "request-1");
    context.set("identity", requestIdentity);
    await next();
  });
  instance.route("/", uploadRoutes);
  return instance;
}

describe("media routes", () => {
  it("strictly validates bind bodies before any database or R2 access", async () => {
    const response = await app(identity()).request(
      "https://forum.example.com/uploads/bind",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          uploadId: UPLOAD_ID,
          topicId: TOPIC_ID,
          postId: POST_ID,
          objectKey: "chosen/by/client.png",
        }),
      },
      bindings(),
    );

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      error: { code: "INVALID_UPLOAD_REQUEST" },
    });
  });

  it("requires an active account before looking up a bind target", async () => {
    const response = await app(
      identity({ status: "suspended" }),
    ).request(
      "https://forum.example.com/uploads/bind",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          uploadId: UPLOAD_ID,
          topicId: TOPIC_ID,
          postId: POST_ID,
        }),
      },
      bindings(),
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: { code: "ACCOUNT_INACTIVE" },
    });
  });

  it.each([
    ["GET", `/media/not-a-uuid`],
    ["GET", `/media/${UPLOAD_ID}/..%2Fsecret`],
    ["GET", `/media/${UPLOAD_ID}/original`],
    ["HEAD", `/media/${UPLOAD_ID}/..%5Csecret`],
  ])("returns the same 404 for malformed media path %s %s", async (method, path) => {
    const response = await app(identity()).request(
      `https://forum.example.com${path}`,
      { method },
      bindings(),
    );

    expect(response.status).toBe(404);
    if (method === "GET") {
      expect(await response.json()).toEqual({
        error: { code: "MEDIA_NOT_FOUND" },
      });
    }
  });
});
