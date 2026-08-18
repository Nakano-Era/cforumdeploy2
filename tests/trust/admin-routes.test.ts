import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { RequestIdentity } from "@/worker/auth/session";
import type { AppEnv, Bindings } from "@/worker/env";
import adminTrustRoutes from "@/worker/routes/admin-trust";

interface FakeStatement {
  sql: string;
  bindings: unknown[];
  bind(...values: unknown[]): FakeStatement;
  all<T>(): Promise<D1Result<T>>;
  first<T>(): Promise<T | null>;
}

const rows = [
  {
    level: 1,
    rule_json: JSON.stringify({
      topicsEntered: 5,
      postsRead: 30,
      readingSeconds: 600,
    }),
    updated_at: 10,
    updated_by: null,
  },
  {
    level: 2,
    rule_json: JSON.stringify({
      topicsEntered: 20,
      postsRead: 100,
      readingSeconds: 3_600,
      visitDays: 15,
      distinctTopicsReplied: 3,
      likesGiven: 1,
      likesReceived: 1,
      demoteAfterInactiveDays: 90,
      warningDays: 14,
    }),
    updated_at: 10,
    updated_by: null,
  },
  {
    level: 3,
    rule_json: JSON.stringify({
      windowDays: 100,
      topicPercent: 25,
      topicCap: 500,
      postPercent: 25,
      postCap: 20_000,
      distinctTopicsReplied: 10,
      readingDays: 50,
      likesGiven: 30,
      likesReceived: 20,
      likeGiverCount: 5,
      likeDayCount: 7,
      maxConfirmedSevereReports: 0,
      sanctionFreeDays: 180,
      graceDays: 14,
      demotionRatio: 0.9,
    }),
    updated_at: 10,
    updated_by: null,
  },
  {
    level: 4,
    rule_json: JSON.stringify({ manualOnly: true }),
    updated_at: 10,
    updated_by: null,
  },
];

function database(capturedBatches: FakeStatement[][] = []): D1Database {
  return {
    prepare(sql: string) {
      const statement: FakeStatement = {
        sql,
        bindings: [],
        bind(...values: unknown[]) {
          statement.bindings = values;
          return statement;
        },
        async all<T>() {
          return {
            success: true,
            results: rows as T[],
            meta: {},
          } as D1Result<T>;
        },
        async first<T>() {
          const level = Number(statement.bindings[0]);
          return (rows.find((row) => row.level === level) ?? null) as T | null;
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

function bindings(db: D1Database): Bindings {
  return {
    CFORUM_DB: db,
    PUBLIC_MEDIA: {} as R2Bucket,
    PRIVATE_MEDIA: {} as R2Bucket,
    EMAIL_QUEUE: {} as Queue,
    ASSETS: {} as Fetcher,
    ENVIRONMENT: "development",
    APP_ORIGIN: "https://forum.example.com",
    PRIVATE_MEDIA_BUCKET_NAME: "private",
    SESSION_HMAC_SECRET: "session-secret".repeat(4),
    OTP_HMAC_SECRET: "otp-secret".repeat(4),
    INVITE_HMAC_SECRET: "invite-secret".repeat(4),
    WEBAUTHN_CHALLENGE_SECRET: "challenge-secret".repeat(4),
    BOOTSTRAP_ADMIN_SECRET: "bootstrap-secret".repeat(4),
  };
}

function identity(withSession = true): RequestIdentity {
  return {
    viewer: {
      userId: "admin-1",
      role: "admin",
      status: "active",
      trustLevel: 4,
      groupIds: new Set(),
      moderatedCategoryIds: new Set(),
    },
    session: withSession
      ? { id: "session-1", userId: "admin-1", csrfHash: "x", expiresAt: 999 }
      : null,
  };
}

function app(requestIdentity: RequestIdentity) {
  const testApp = new Hono<AppEnv>();
  testApp.use("*", async (context, next) => {
    context.set("identity", requestIdentity);
    context.set("requestId", "request-1");
    await next();
  });
  testApp.route("/", adminTrustRoutes);
  return testApp;
}

describe("admin trust rule routes", () => {
  it("requires an active admin session", async () => {
    const response = await app(identity(false)).request(
      "https://forum.example.com/admin/trust-levels/rules",
      undefined,
      bindings(database()),
    );
    expect(response.status).toBe(401);
  });

  it("returns only rules that pass the level-specific schema", async () => {
    const response = await app(identity()).request(
      "https://forum.example.com/admin/trust-levels/rules",
      undefined,
      bindings(database()),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { rules: Array<{ level: number }> };
    expect(body.rules.map((rule) => rule.level)).toEqual([1, 2, 3, 4]);
  });

  it("updates with optimistic concurrency and writes an audit in one batch", async () => {
    const captured: FakeStatement[][] = [];
    const response = await app(identity()).request(
      "https://forum.example.com/admin/trust-levels/rules/1",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expectedUpdatedAt: 10,
          rule: { topicsEntered: 6, postsRead: 31, readingSeconds: 601 },
        }),
      },
      bindings(database(captured)),
    );
    expect(response.status).toBe(200);
    expect(captured[0]).toHaveLength(2);
    expect(captured[0]?.[0]?.sql).toContain("AND updated_at = ?5");
    expect(captured[0]?.[1]?.sql).toContain("WHERE changes() = 1");
    expect(captured[0]?.[1]?.sql).toContain("trust_level.rule.update");
  });

  it("rejects malformed nested rules before writing", async () => {
    const captured: FakeStatement[][] = [];
    const response = await app(identity()).request(
      "https://forum.example.com/admin/trust-levels/rules/4",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expectedUpdatedAt: 10,
          rule: { manualOnly: false },
        }),
      },
      bindings(database(captured)),
    );
    expect(response.status).toBe(422);
    expect(captured).toHaveLength(0);
  });
});
