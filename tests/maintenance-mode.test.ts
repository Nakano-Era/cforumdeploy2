import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import workerApp from "@/worker/app";
import type { RequestIdentity } from "@/worker/auth/session";
import type { AppEnv, Bindings } from "@/worker/env";
import {
  enforceMaintenanceMode,
  isMaintenanceRecoveryMutation,
} from "@/worker/middleware/maintenance";
import { isMaintenanceModeEnabled } from "@/worker/repositories/settings";
import adminRoutes from "@/worker/routes/admin";
import { hmacSha256 } from "@/worker/security/crypto";

const SESSION_SECRET = "session-secret".repeat(4);

const BLOCKED_MUTATIONS = [
  ["POST", "/api/auth/register"],
  ["POST", "/api/auth/passkeys/register/options"],
  ["POST", "/api/auth/passkeys/register/verify"],
  ["POST", "/api/topics"],
  ["POST", "/api/topics/topic-1/replies"],
  ["POST", "/api/posts/post-1/reactions"],
  ["POST", "/api/posts/post-1/bookmark"],
  ["POST", "/api/posts/post-1/reports"],
  ["POST", "/api/uploads/authorize"],
  ["POST", "/api/uploads/finalize"],
  ["POST", "/api/uploads/bind"],
  ["DELETE", "/api/uploads/upload-1"],
  ["POST", "/api/notifications/read"],
  ["POST", "/api/activity/reading-heartbeat"],
  ["POST", "/api/admin/review/review-1/decision"],
  ["PATCH", "/api/admin/settings"],
  ["PATCH", "/api/admin/trust-levels/rules/1"],
] as const;

const RECOVERY_MUTATIONS = [
  ["POST", "/api/bootstrap"],
  ["POST", "/api/auth/email/request-code"],
  ["POST", "/api/auth/email/verify"],
  ["POST", "/api/auth/email/consume-login"],
  ["POST", "/api/auth/passkeys/authenticate/options"],
  ["POST", "/api/auth/passkeys/authenticate/verify"],
  ["POST", "/api/auth/logout"],
  ["POST", "/api/auth/logout-all"],
] as const;

interface FakeStatement {
  readonly sql: string;
  bindings: unknown[];
  bind(...values: unknown[]): FakeStatement;
  first<T>(): Promise<T | null>;
}

function result<T>(results: T[] = [], changes = 0): D1Result<T> {
  return {
    success: true,
    results,
    meta: { changes },
  } as D1Result<T>;
}

function bindings(database: D1Database): Bindings {
  return {
    CFORUM_DB: database,
    PUBLIC_MEDIA: {} as R2Bucket,
    PRIVATE_MEDIA: {} as R2Bucket,
    EMAIL_QUEUE: {} as Queue,
    ASSETS: {} as Fetcher,
    ENVIRONMENT: "development",
    APP_ORIGIN: "https://forum.example.com",
    PRIVATE_MEDIA_BUCKET_NAME: "private-media",
    SESSION_HMAC_SECRET: SESSION_SECRET,
    OTP_HMAC_SECRET: "otp-secret".repeat(4),
    INVITE_HMAC_SECRET: "invite-secret".repeat(4),
    WEBAUTHN_CHALLENGE_SECRET: "challenge-secret".repeat(4),
    BOOTSTRAP_ADMIN_SECRET: "bootstrap-secret".repeat(4),
  };
}

function identity(
  overrides: Partial<RequestIdentity["viewer"]> = {},
  withSession = true,
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
    session:
      withSession && viewer.userId
        ? {
            id: "session-1",
            userId: viewer.userId,
            csrfHash: "csrf-hash",
            expiresAt: 2_000_000_000,
          }
        : null,
  };
}

function settingDatabase(
  value: string | null,
  sqlLog: string[] = [],
): D1Database {
  return {
    prepare(sql: string) {
      sqlLog.push(sql);
      const statement: FakeStatement = {
        sql,
        bindings: [],
        bind(...values: unknown[]) {
          statement.bindings = values;
          return statement;
        },
        async first<T>() {
          return (value === null ? null : { value_json: value }) as T | null;
        },
      };
      return statement as unknown as D1PreparedStatement;
    },
  } as unknown as D1Database;
}

function middlewareHarness(
  requestIdentity: RequestIdentity,
  database: D1Database,
  downstream: string[] = [],
) {
  const app = new Hono<AppEnv>();
  app.use("*", async (context, next) => {
    context.set("requestId", "request-1");
    context.set("identity", requestIdentity);
    await next();
  });
  app.use("*", enforceMaintenanceMode);
  app.all("*", async (context) => {
    downstream.push(`${context.req.method} ${context.req.path}`);
    return context.json({ reached: true, body: await context.req.text() });
  });
  return app;
}

function request(
  app: ReturnType<typeof middlewareHarness>,
  method: string,
  path: string,
  database: D1Database,
  body?: string,
) {
  return app.request(
    `https://forum.example.com${path}`,
    {
      method,
      ...(body === undefined
        ? {}
        : { headers: { "content-type": "application/json" }, body }),
    },
    bindings(database),
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("maintenance setting", () => {
  it.each([
    ["true", true],
    ["false", false],
    ['"true"', false],
    ["0", false],
  ])("strictly parses %s", async (stored, expected) => {
    await expect(
      isMaintenanceModeEnabled(settingDatabase(stored)),
    ).resolves.toBe(expected);
  });

  it("uses the migration-compatible false default when the row is absent", async () => {
    await expect(
      isMaintenanceModeEnabled(settingDatabase(null)),
    ).resolves.toBe(false);
  });

  it("does not fail open when the stored JSON is corrupt", async () => {
    await expect(
      isMaintenanceModeEnabled(settingDatabase("not-json")),
    ).rejects.toBeInstanceOf(SyntaxError);
  });
});

describe("maintenance recovery allowlist", () => {
  it.each(RECOVERY_MUTATIONS)("recognizes %s %s", (method, path) => {
    expect(isMaintenanceRecoveryMutation(method, path)).toBe(true);
    expect(isMaintenanceRecoveryMutation(method, `${path}/`)).toBe(true);
  });

  it.each([
    ["POST", "/api/auth/register"],
    ["POST", "/api/auth/passkeys/register/options"],
    ["GET", "/api/auth/email/verify"],
    ["POST", "/api/auth/email/consume-login/extra"],
  ])("does not broaden the allowlist to %s %s", (method, path) => {
    expect(isMaintenanceRecoveryMutation(method, path)).toBe(false);
  });
});

describe("maintenance middleware", () => {
  it.each(["GET", "HEAD", "OPTIONS"])(
    "does not query settings for safe %s requests",
    async (method) => {
      const sqlLog: string[] = [];
      const database = settingDatabase("true", sqlLog);
      const downstream: string[] = [];
      const response = await request(
        middlewareHarness(identity(), database, downstream),
        method,
        "/api/topics/topic-1",
        database,
      );

      expect(response.status).toBe(200);
      expect(sqlLog).toHaveLength(0);
      expect(downstream).toEqual([`${method} /api/topics/topic-1`]);
    },
  );

  it.each(BLOCKED_MUTATIONS)(
    "blocks member and moderator mutation %s %s before downstream work",
    async (method, path) => {
      for (const role of ["member", "moderator"] as const) {
        const database = settingDatabase("true");
        const downstream: string[] = [];
        const response = await request(
          middlewareHarness(identity({ role }), database, downstream),
          method,
          path,
          database,
          method === "DELETE" ? undefined : JSON.stringify({ secret: "body" }),
        );

        expect(response.status).toBe(503);
        await expect(response.json()).resolves.toEqual({
          error: { code: "SITE_MAINTENANCE" },
        });
        expect(downstream).toHaveLength(0);
      }
    },
  );

  it.each(BLOCKED_MUTATIONS)(
    "lets an active administrator bypass %s %s without reading the switch",
    async (method, path) => {
      const database = {
        prepare() {
          throw new Error("maintenance setting must not be read for an admin");
        },
      } as unknown as D1Database;
      const downstream: string[] = [];
      const response = await request(
        middlewareHarness(
          identity({ role: "admin", status: "active", trustLevel: 4 }),
          database,
          downstream,
        ),
        method,
        path,
        database,
      );

      expect(response.status).toBe(200);
      expect(downstream).toEqual([`${method} ${path}`]);
    },
  );

  it.each(RECOVERY_MUTATIONS)(
    "keeps recovery mutation %s %s available without reading the switch",
    async (method, path) => {
      const database = {
        prepare() {
          throw new Error("recovery requests must not read maintenance mode");
        },
      } as unknown as D1Database;
      const downstream: string[] = [];
      const response = await request(
        middlewareHarness(identity(), database, downstream),
        method,
        path,
        database,
      );

      expect(response.status).toBe(200);
      expect(downstream).toEqual([`${method} ${path}`]);
    },
  );

  it.each([
    ["inactive admin", identity({ role: "admin", status: "suspended" })],
    [
      "sessionless admin",
      identity({ role: "admin", status: "active", trustLevel: 4 }, false),
    ],
  ])("does not grant a bypass to an %s", async (_label, requestIdentity) => {
    const database = settingDatabase("true");
    const response = await request(
      middlewareHarness(requestIdentity, database),
      "PATCH",
      "/api/admin/settings",
      database,
    );

    expect(response.status).toBe(503);
  });

  it.each([
    ["POST", "/api/topics"],
    ["PATCH", "/api/admin/settings"],
    ["DELETE", "/api/uploads/upload-1"],
  ])("passes %s mutations through when maintenance is disabled", async (method, path) => {
    const database = settingDatabase("false");
    const downstream: string[] = [];
    const response = await request(
      middlewareHarness(identity(), database, downstream),
      method,
      path,
      database,
      method === "DELETE" ? undefined : '{"kept":true}',
    );

    expect(response.status).toBe(200);
    expect(downstream).toEqual([`${method} ${path}`]);
    if (method !== "DELETE") {
      await expect(response.json()).resolves.toMatchObject({
        body: '{"kept":true}',
      });
    }
  });
});

describe("maintenance integration", () => {
  it("lets an active administrator disable maintenance through the real settings route", async () => {
    const sqlLog: string[] = [];
    const batches: D1PreparedStatement[][] = [];
    const database = {
      prepare(sql: string) {
        sqlLog.push(sql);
        const statement = {
          bind() {
            return statement;
          },
        };
        return statement as unknown as D1PreparedStatement;
      },
      async batch(statements: D1PreparedStatement[]) {
        batches.push(statements);
        return statements.map(() => result([], 1));
      },
    } as unknown as D1Database;
    const app = new Hono<AppEnv>();
    app.use("*", async (context, next) => {
      context.set("requestId", "request-1");
      context.set(
        "identity",
        identity({ role: "admin", status: "active", trustLevel: 4 }),
      );
      await next();
    });
    app.use("*", enforceMaintenanceMode);
    app.route("/api", adminRoutes);

    const response = await app.request(
      "https://forum.example.com/api/admin/settings",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ maintenanceMode: false }),
      },
      bindings(database),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      settings: { maintenanceMode: false },
    });
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(2);
    expect(sqlLog.some((sql) => sql.includes("SELECT value_json"))).toBe(false);
  });

  it("enforces maintenance through the real app after valid Origin and CSRF checks", async () => {
    const csrfToken = "csrf-token";
    const csrfHash = await hmacSha256(SESSION_SECRET, csrfToken);
    const sqlLog: string[] = [];
    const database = requestIdentityDatabase(csrfHash, sqlLog);

    const response = await workerApp.request(
      "https://forum.example.com/api/topics",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: `cforum_session=session-token; cforum_csrf=${csrfToken}`,
          origin: "https://forum.example.com",
          "x-csrf-token": csrfToken,
        },
        body: JSON.stringify({ invalid: "route must not parse this" }),
      },
      bindings(database),
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: { code: "SITE_MAINTENANCE" },
    });
    expect(sqlLog.some((sql) => sql.includes("maintenance_mode"))).toBe(true);
    expect(sqlLog.some((sql) => sql.includes("FROM categories"))).toBe(false);
  });

  it("keeps request security checks ahead of the maintenance response", async () => {
    const csrfHash = await hmacSha256(SESSION_SECRET, "expected-token");
    const sqlLog: string[] = [];
    const database = requestIdentityDatabase(csrfHash, sqlLog);

    const response = await workerApp.request(
      "https://forum.example.com/api/topics",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: "cforum_session=session-token; cforum_csrf=wrong-token",
          origin: "https://forum.example.com",
          "x-csrf-token": "wrong-token",
        },
        body: "{}",
      },
      bindings(database),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: { code: "INVALID_CSRF_TOKEN" },
    });
    expect(sqlLog.some((sql) => sql.includes("maintenance_mode"))).toBe(false);
  });

  it("leaves real read routes available without a maintenance lookup", async () => {
    const sqlLog: string[] = [];
    const database = {
      prepare(sql: string) {
        sqlLog.push(sql);
        return {
          async first<T>() {
            return { ok: 1 } as T;
          },
        } as unknown as D1PreparedStatement;
      },
    } as unknown as D1Database;

    const response = await workerApp.request(
      "https://forum.example.com/api/health",
      { method: "GET" },
      bindings(database),
    );

    expect(response.status).toBe(200);
    expect(sqlLog.some((sql) => sql.includes("maintenance_mode"))).toBe(false);
  });

  it("fails closed through the real app error contract when the setting cannot be read", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const database = {
      prepare() {
        throw new Error("database unavailable");
      },
    } as unknown as D1Database;

    const response = await workerApp.request(
      "https://forum.example.com/api/topics",
      {
        method: "POST",
        headers: { origin: "https://forum.example.com" },
      },
      bindings(database),
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: { code: "INTERNAL_ERROR" },
    });
  });
});

function requestIdentityDatabase(
  csrfHash: string,
  sqlLog: string[],
): D1Database {
  return {
    prepare(sql: string) {
      sqlLog.push(sql);
      const statement: FakeStatement = {
        sql,
        bindings: [],
        bind(...values: unknown[]) {
          statement.bindings = values;
          return statement;
        },
        async first<T>() {
          if (sql.includes("FROM sessions s")) {
            return {
              session_id: "session-1",
              user_id: "user-1",
              csrf_hash: csrfHash,
              expires_at: 2_000_000_000,
              role: "member",
              status: "active",
              trust_level: 1,
            } as T;
          }
          if (sql.includes("maintenance_mode")) {
            return { value_json: "true" } as T;
          }
          throw new Error(`unexpected first query: ${sql}`);
        },
      };
      return statement as unknown as D1PreparedStatement;
    },
    async batch(statements: D1PreparedStatement[]) {
      return statements.map(() => result([]));
    },
  } as unknown as D1Database;
}
