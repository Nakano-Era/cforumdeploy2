import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { RequestIdentity } from "@/worker/auth/session";
import type { AppEnv, Bindings } from "@/worker/env";
import notificationRoutes, {
  readNotificationsSchema,
} from "@/worker/routes/notifications";

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

function identity(
  overrides: Partial<RequestIdentity["viewer"]> = {},
): RequestIdentity {
  const viewer = {
    userId: "user-1",
    role: "member" as const,
    status: "active" as const,
    trustLevel: 1 as const,
    groupIds: new Set<string>(),
    moderatedCategoryIds: new Set<string>(),
    ...overrides,
  };
  return {
    viewer,
    session: viewer.userId
      ? {
          id: "session-1",
          userId: viewer.userId,
          csrfHash: "csrf-hash",
          expiresAt: 2_000_000_000,
        }
      : null,
  };
}

function testApp(requestIdentity: RequestIdentity) {
  const app = new Hono<AppEnv>();
  app.use("*", async (context, next) => {
    context.set("requestId", "request-1");
    context.set("identity", requestIdentity);
    await next();
  });
  app.route("/", notificationRoutes);
  return app;
}

function throwingDatabase(): D1Database {
  return {
    prepare() {
      throw new Error("database should not be accessed");
    },
  } as unknown as D1Database;
}

function notificationDatabase(): D1Database {
  return {
    prepare(sql: string) {
      const statement = {
        bind() {
          return statement;
        },
        async all() {
          if (!sql.includes("FROM notifications n")) {
            throw new Error(`unexpected all query: ${sql}`);
          }
          return {
            success: true,
            meta: {},
            results: [
              {
                id: "notification-1",
                kind: "review_decision",
                topic_id: "hidden-topic",
                post_id: "hidden-post",
                data_json: JSON.stringify({
                  reviewItemId: "review-1",
                  action: "reject_first_post",
                  title: "不得泄漏的标题",
                  excerpt: "不得泄漏的内容",
                }),
                created_at: 1_700_000_000,
                read_at: null,
                actor_id: "staff-1",
                actor_username: "staff",
                actor_display_name: "审核员",
                target_accessible: 0,
              },
            ],
          };
        },
        async first() {
          if (sql.includes("COUNT(*) AS count")) return { count: 1 };
          throw new Error(`unexpected first query: ${sql}`);
        },
      };
      return statement;
    },
  } as unknown as D1Database;
}

describe("notification contracts", () => {
  it("requires exactly one read mode", () => {
    expect(readNotificationsSchema.safeParse({}).success).toBe(false);
    expect(
      readNotificationsSchema.safeParse({ ids: ["n-1"], all: true }).success,
    ).toBe(false);
    expect(readNotificationsSchema.safeParse({ ids: ["n-1"] }).success).toBe(
      true,
    );
    expect(readNotificationsSchema.safeParse({ all: true }).success).toBe(true);
  });

  it("rejects client-supplied user identities", () => {
    expect(
      readNotificationsSchema.safeParse({ ids: ["n-1"], userId: "other" })
        .success,
    ).toBe(false);
  });
});

describe("notification routes", () => {
  it("authenticates before touching the database", async () => {
    const response = await testApp(
      identity({
        userId: null,
        role: "guest",
        status: "guest",
        trustLevel: null,
      }),
    ).request(
      "https://forum.example.com/notifications",
      undefined,
      bindings(throwingDatabase()),
    );
    expect(response.status).toBe(401);
  });

  it("keeps an inaccessible notification but removes target and content leaks", async () => {
    const response = await testApp(identity()).request(
      "https://forum.example.com/notifications",
      undefined,
      bindings(notificationDatabase()),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      notifications: Array<Record<string, unknown>>;
      unreadCount: number;
    };
    expect(body.unreadCount).toBe(1);
    expect(body.notifications[0]).toMatchObject({
      id: "notification-1",
      topicId: null,
      postId: null,
      targetAvailable: false,
      data: {
        reviewItemId: "review-1",
        action: "reject_first_post",
      },
    });
    expect(JSON.stringify(body)).not.toContain("不得泄漏");
  });

  it("rejects inactive accounts before a read mutation", async () => {
    const response = await testApp(identity({ status: "suspended" })).request(
      "https://forum.example.com/notifications/read",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ all: true }),
      },
      bindings(throwingDatabase()),
    );
    expect(response.status).toBe(403);
  });
});
