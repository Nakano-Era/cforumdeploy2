import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { RequestIdentity } from "@/worker/auth/session";
import type { AppEnv, Bindings } from "@/worker/env";
import moderationRoutes, {
  reportInputSchema,
  reviewDecisionSchema,
  reviewListQuerySchema,
} from "@/worker/routes/moderation";

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

function throwingDatabase(): D1Database {
  return {
    prepare() {
      throw new Error("database should not be accessed");
    },
  } as unknown as D1Database;
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
  app.route("/", moderationRoutes);
  return app;
}

function post(
  app: ReturnType<typeof testApp>,
  path: string,
  body: unknown,
  database: D1Database = throwingDatabase(),
) {
  return app.request(
    `https://forum.example.com${path}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
    bindings(database),
  );
}

function reviewDatabase(row: Record<string, unknown>): D1Database {
  return {
    prepare(sql: string) {
      const statement = {
        bind() {
          return statement;
        },
        async first() {
          if (sql.includes("FROM review_items WHERE id")) return row;
          throw new Error(`unexpected first query: ${sql}`);
        },
      };
      return statement;
    },
  } as unknown as D1Database;
}

const pendingReview = {
  id: "review-1",
  type: "report",
  category_id: "category-secret",
  submitted_by: "reporter-1",
  target_user_id: "author-1",
  target_topic_id: "topic-1",
  target_post_id: "post-1",
  content_snapshot_json: JSON.stringify({ reportId: "report-1" }),
  status: "pending",
  claimed_by: null,
  action: null,
  handled_at: null,
};

describe("moderation input contracts", () => {
  it("requires details for illegal and other reports", () => {
    expect(reportInputSchema.safeParse({ type: "illegal", detail: "" }).success).toBe(
      false,
    );
    expect(
      reportInputSchema.safeParse({ type: "other", detail: "补充说明" }).success,
    ).toBe(true);
  });

  it("rejects report, decision, and list fields outside the contract", () => {
    expect(
      reportInputSchema.safeParse({ type: "spam", detail: "", topicId: "x" })
        .success,
    ).toBe(false);
    expect(
      reviewDecisionSchema.safeParse({ decision: "approve", force: true }).success,
    ).toBe(false);
    expect(reviewListQuerySchema.safeParse({ type: "spam" }).success).toBe(false);
  });

  it("accepts only the four persisted review item types", () => {
    for (const type of [
      "registration",
      "first_post",
      "media_post",
      "report",
    ]) {
      expect(reviewListQuerySchema.safeParse({ type }).success).toBe(true);
    }
  });
});

describe("moderation route authorization", () => {
  it("authenticates and checks active status before report object lookup", async () => {
    const guest = await post(
      testApp(
        identity({
          userId: null,
          role: "guest",
          status: "guest",
          trustLevel: null,
        }),
      ),
      "/posts/post-1/reports",
      { type: "spam", detail: "" },
    );
    expect(guest.status).toBe(401);

    const silenced = await post(
      testApp(identity({ status: "silenced" })),
      "/posts/post-1/reports",
      { type: "spam", detail: "" },
    );
    expect(silenced.status).toBe(403);
  });

  it("rejects malformed reports before database access", async () => {
    const response = await post(
      testApp(identity()),
      "/posts/post-1/reports",
      { type: "illegal", detail: "" },
    );
    expect(response.status).toBe(422);
  });

  it("returns an empty scoped queue for a moderator with no categories", async () => {
    const response = await testApp(
      identity({ role: "moderator", moderatedCategoryIds: new Set() }),
    ).request(
      "https://forum.example.com/admin/review",
      undefined,
      bindings(throwingDatabase()),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      items: [],
      nextCursor: null,
      capabilities: { scope: "categories", categoryIds: [] },
    });
  });

  it("conceals an out-of-scope review item from category moderators", async () => {
    const response = await post(
      testApp(
        identity({
          role: "moderator",
          moderatedCategoryIds: new Set(["category-own"]),
        }),
      ),
      "/admin/review/review-1/decision",
      { decision: "approve" },
      reviewDatabase(pendingReview),
    );
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: { code: "NOT_FOUND" },
    });
  });

  it("treats a repeated same-state decision as an idempotent success", async () => {
    const response = await post(
      testApp(
        identity({
          role: "moderator",
          moderatedCategoryIds: new Set(["category-secret"]),
        }),
      ),
      "/admin/review/review-1/decision",
      { decision: "approve" },
      reviewDatabase({
        ...pendingReview,
        status: "approved",
        action: "accept_report",
        handled_at: 1_700_000_000,
      }),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      item: {
        id: "review-1",
        status: "approved",
        action: "accept_report",
        handledAt: "2023-11-14T22:13:20.000Z",
      },
    });
  });
});
