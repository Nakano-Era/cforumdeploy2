import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { RequestIdentity } from "@/worker/auth/session";
import type { AppEnv, Bindings } from "@/worker/env";
import interactionRoutes from "@/worker/routes/interactions";

function throwingDatabase(): D1Database {
  return {
    prepare() {
      throw new Error("database should not be accessed");
    },
  } as unknown as D1Database;
}

function bindings(database: D1Database): Bindings {
  return {
    CFORUM_DB: database,
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
  } as Bindings;
}

const guestIdentity: RequestIdentity = {
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

function memberIdentity(status: "active" | "silenced" = "active"): RequestIdentity {
  return {
    viewer: {
      userId: "user-1",
      role: "member",
      status,
      trustLevel: 0,
      groupIds: new Set(),
      moderatedCategoryIds: new Set(),
    },
    session: {
      id: "session-1",
      userId: "user-1",
      csrfHash: "csrf-hash",
      expiresAt: 2_000_000_000,
    },
  };
}

function testApp(identity: RequestIdentity) {
  const app = new Hono<AppEnv>();
  app.use("*", async (context, next) => {
    context.set("requestId", "request-1");
    context.set("identity", identity);
    await next();
  });
  app.route("/", interactionRoutes);
  return app;
}

function post(
  app: ReturnType<typeof testApp>,
  path: string,
  body: unknown,
  env: Bindings,
) {
  return app.request(
    `https://forum.example.com${path}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
    env,
  );
}

function objectDatabase(kind: "unknown" | "restricted"): D1Database {
  return {
    prepare(sql: string) {
      const statement = {
        bind() {
          return statement;
        },
        async first() {
          if (sql.includes("SELECT p.id AS post_id")) {
            return kind === "unknown"
              ? null
              : { post_id: "post-secret", topic_id: "topic-secret" };
          }
          if (sql.includes("author.trust_level AS author_trust_level")) {
            return {
              id: "topic-secret",
              category_id: "category-secret",
              author_id: "author-1",
              min_view_level: 3,
              effective_min_view_level: 3,
              author_qualified_visibility_level: 3,
              author_downgrade_locked: 0,
              status: "open",
              author_trust_level: 3,
            };
          }
          if (sql.includes("FROM categories WHERE id")) {
            return {
              id: "category-secret",
              slug: "secret",
              name: "Secret",
              description: "",
              color: "#000000",
              state: "active",
              acl_mode: "restricted",
              min_view_level: 3,
              min_reply_level: 3,
              min_create_level: 3,
              allowed_topic_min_level_max: 4,
              require_topic_approval: 0,
              require_reply_approval: 0,
              allow_images: 1,
            };
          }
          throw new Error(`unexpected first query: ${sql}`);
        },
        async all() {
          if (sql.includes("FROM category_permissions")) {
            return { success: true, results: [], meta: {} };
          }
          throw new Error(`unexpected all query: ${sql}`);
        },
      };
      return statement;
    },
  } as unknown as D1Database;
}

describe("interaction routes", () => {
  it("requires an active authenticated account before object lookup", async () => {
    const env = bindings(throwingDatabase());
    const guest = await post(
      testApp(guestIdentity),
      "/posts/post-1/reactions",
      { desired: true },
      env,
    );
    expect(guest.status).toBe(401);

    const silenced = await post(
      testApp(memberIdentity("silenced")),
      "/posts/post-1/bookmark",
      { desired: true },
      env,
    );
    expect(silenced.status).toBe(403);
  });

  it("does not accept a client-supplied topic identity", async () => {
    const response = await post(
      testApp(memberIdentity()),
      "/posts/post-1/bookmark",
      { desired: true, topicId: "attacker-topic" },
      bindings(throwingDatabase()),
    );
    expect(response.status).toBe(422);
  });

  it("requires an explicit desired reaction state for retry idempotency", async () => {
    const response = await post(
      testApp(memberIdentity()),
      "/posts/post-1/reactions",
      { type: "like" },
      bindings(throwingDatabase()),
    );
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({
      error: { code: "INVALID_INPUT" },
    });
  });

  it("returns the same 404 for unknown and permission-denied posts", async () => {
    const app = testApp(memberIdentity());
    const [unknown, restricted] = await Promise.all([
      post(
        app,
        "/posts/post-unknown/reactions",
        { desired: true },
        bindings(objectDatabase("unknown")),
      ),
      post(
        app,
        "/posts/post-secret/reactions",
        { desired: true },
        bindings(objectDatabase("restricted")),
      ),
    ]);
    expect(unknown.status).toBe(404);
    expect(restricted.status).toBe(404);
    await expect(unknown.json()).resolves.toEqual({
      error: { code: "NOT_FOUND" },
    });
    await expect(restricted.json()).resolves.toEqual({
      error: { code: "NOT_FOUND" },
    });
  });

  it("validates search length before reading FTS", async () => {
    const response = await testApp(guestIdentity).request(
      "https://forum.example.com/search?q=x",
      undefined,
      bindings(throwingDatabase()),
    );
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({
      error: { code: "INVALID_QUERY" },
    });
  });
});
