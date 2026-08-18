import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { RequestIdentity } from "@/worker/auth/session";
import type { AppEnv, Bindings } from "@/worker/env";
import adminInviteRoutes, {
  createInviteSchema,
  inviteListQuerySchema,
  revokeInviteSchema,
} from "@/worker/routes/admin-invites";
import { hashInviteToken } from "@/worker/routes/auth";

interface FakeStatement {
  sql: string;
  bindings: unknown[];
  bind(...values: unknown[]): FakeStatement;
  all<T>(): Promise<D1Result<T>>;
  first<T>(): Promise<T | null>;
}

const INVITE_SECRET = "invite-secret".repeat(4);

function bindings(database: D1Database, secret = INVITE_SECRET): Bindings {
  return {
    CFORUM_DB: database,
    PUBLIC_MEDIA: {} as R2Bucket,
    PRIVATE_MEDIA: {} as R2Bucket,
    EMAIL_QUEUE: {} as Queue,
    ASSETS: {} as Fetcher,
    ENVIRONMENT: "development",
    APP_ORIGIN: "https://forum.example.com",
    PRIVATE_MEDIA_BUCKET_NAME: "private",
    SESSION_HMAC_SECRET: "session-secret".repeat(4),
    OTP_HMAC_SECRET: "otp-secret".repeat(4),
    INVITE_HMAC_SECRET: secret,
    WEBAUTHN_CHALLENGE_SECRET: "challenge-secret".repeat(4),
    BOOTSTRAP_ADMIN_SECRET: "bootstrap-secret".repeat(4),
  };
}

function identity(
  overrides: Partial<RequestIdentity["viewer"]> = {},
  withSession = true,
): RequestIdentity {
  const viewer = {
    userId: "admin-1",
    role: "admin" as const,
    status: "active" as const,
    trustLevel: 4 as const,
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

function testApp(requestIdentity: RequestIdentity) {
  const app = new Hono<AppEnv>();
  app.use("*", async (context, next) => {
    context.set("requestId", "request-1");
    context.set("identity", requestIdentity);
    await next();
  });
  app.route("/", adminInviteRoutes);
  return app;
}

function throwingDatabase(): D1Database {
  return {
    prepare() {
      throw new Error("database should not be accessed");
    },
  } as unknown as D1Database;
}

function request(
  requestIdentity: RequestIdentity,
  path: string,
  init: RequestInit | undefined,
  database: D1Database,
  secret = INVITE_SECRET,
) {
  return testApp(requestIdentity).request(
    `https://forum.example.com${path}`,
    init,
    bindings(database, secret),
  );
}

function jsonMutation(method: "POST" | "PATCH", body: unknown): RequestInit {
  return {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

function createDatabase(capturedBatches: FakeStatement[][]): D1Database {
  return {
    prepare(sql: string) {
      const statement: FakeStatement = {
        sql,
        bindings: [],
        bind(...values: unknown[]) {
          statement.bindings = values;
          return statement;
        },
        async all() {
          throw new Error(`unexpected all query: ${sql}`);
        },
        async first<T>() {
          if (sql.includes("FROM users WHERE id")) {
            return {
              id: "admin-1",
              username: "admin",
              display_name: "站点管理员",
            } as T;
          }
          throw new Error(`unexpected first query: ${sql}`);
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

function listDatabase(captured: FakeStatement[], now: number): D1Database {
  const rows = Array.from({ length: 21 }, (_, index) => ({
    id: `invite-${String(index).padStart(2, "0")}`,
    max_uses: 1,
    used_count: index === 1 ? 1 : 0,
    expires_at: index === 2 ? now - 1 : null,
    revoked_at: index === 0 ? now - 10 : null,
    created_at: now - index,
    created_by_id: "admin-1",
    created_by_username: "admin",
    created_by_display_name: "站点管理员",
  }));
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
          captured.push(statement);
          return {
            success: true,
            results: rows as T[],
            meta: {},
          } as D1Result<T>;
        },
        async first() {
          throw new Error(`unexpected first query: ${sql}`);
        },
      };
      return statement as unknown as D1PreparedStatement;
    },
  } as unknown as D1Database;
}

interface RevokeDatabaseResult {
  database: D1Database;
  batches: FakeStatement[][];
}

function revokeDatabase(initialRevokedAt: number | null): RevokeDatabaseResult {
  const batches: FakeStatement[][] = [];
  let revokedAt = initialRevokedAt;
  const row = () => ({
    id: "invite-1",
    max_uses: 1,
    used_count: 0,
    expires_at: null,
    revoked_at: revokedAt,
    created_at: 1_700_000_000,
    created_by_id: "admin-1",
    created_by_username: "admin",
    created_by_display_name: "站点管理员",
  });
  const database = {
    prepare(sql: string) {
      const statement: FakeStatement = {
        sql,
        bindings: [],
        bind(...values: unknown[]) {
          statement.bindings = values;
          return statement;
        },
        async all() {
          throw new Error(`unexpected all query: ${sql}`);
        },
        async first<T>() {
          if (sql.includes("FROM invites i")) return row() as T;
          throw new Error(`unexpected first query: ${sql}`);
        },
      };
      return statement as unknown as D1PreparedStatement;
    },
    async batch(statements: D1PreparedStatement[]) {
      const batch = statements as unknown as FakeStatement[];
      batches.push(batch);
      revokedAt = Number(batch[0]?.bindings[1]);
      return statements.map(() => ({
        success: true,
        results: [],
        meta: { changes: 1 },
      })) as unknown as D1Result[];
    },
  } as unknown as D1Database;
  return { database, batches };
}

describe("admin invite input contracts", () => {
  it("keeps the P0 creation contract single-use and strict", () => {
    expect(createInviteSchema.safeParse({ maxUses: 1 }).success).toBe(true);
    expect(createInviteSchema.safeParse({ maxUses: 2 }).success).toBe(false);
    expect(
      createInviteSchema.safeParse({ maxUses: 1, allowedDomain: "example.com" })
        .success,
    ).toBe(false);
    expect(revokeInviteSchema.safeParse({ revoked: true }).success).toBe(true);
    expect(revokeInviteSchema.safeParse({ revoked: false }).success).toBe(false);
    expect(inviteListQuerySchema.safeParse({}).success).toBe(true);
    expect(inviteListQuerySchema.safeParse({ status: "active" }).success).toBe(
      false,
    );
  });
});

describe("admin invite route authorization", () => {
  it("requires a session and an active administrator", async () => {
    const guest = await request(
      identity(
        {
          userId: null,
          role: "guest",
          status: "guest",
          trustLevel: null,
        },
        false,
      ),
      "/admin/invites",
      undefined,
      throwingDatabase(),
    );
    expect(guest.status).toBe(401);

    const moderator = await request(
      identity({ role: "moderator" }),
      "/admin/invites",
      undefined,
      throwingDatabase(),
    );
    expect(moderator.status).toBe(403);

    const inactiveAdmin = await request(
      identity({ status: "silenced" }),
      "/admin/invites",
      undefined,
      throwingDatabase(),
    );
    expect(inactiveAdmin.status).toBe(403);
  });
});

describe("admin invite creation", () => {
  it("returns the raw token once while persisting only its HMAC and safe audit data", async () => {
    const captured: FakeStatement[][] = [];
    const response = await request(
      identity(),
      "/admin/invites",
      jsonMutation("POST", { maxUses: 1 }),
      createDatabase(captured),
    );
    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      token: string;
      invite: { id: string; status: string; maxUses: number };
    };
    expect(body.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(body.invite).toMatchObject({ status: "active", maxUses: 1 });
    expect(captured).toHaveLength(1);
    expect(captured[0]).toHaveLength(2);

    const inviteInsert = captured[0]?.[0];
    const auditInsert = captured[0]?.[1];
    expect(inviteInsert?.sql).not.toContain("email_hash");
    expect(inviteInsert?.bindings[1]).toBe(
      await hashInviteToken(INVITE_SECRET, body.token),
    );
    expect(inviteInsert?.bindings).not.toContain(body.token);
    expect(auditInsert?.bindings).not.toContain(body.token);
    expect(JSON.stringify(auditInsert?.bindings)).not.toContain(body.token);
    expect(auditInsert?.sql).toContain("invite.create");
  });

  it("fails closed before database access when the invite secret is short", async () => {
    const response = await request(
      identity(),
      "/admin/invites",
      jsonMutation("POST", { maxUses: 1 }),
      throwingDatabase(),
      "too-short",
    );
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: { code: "INVITE_SERVICE_UNAVAILABLE" },
    });
  });
});

describe("admin invite listing", () => {
  it("uses a descending keyset and never selects stored invitation secrets", async () => {
    const captured: FakeStatement[] = [];
    const now = Math.floor(Date.now() / 1_000);
    const database = listDatabase(captured, now);
    const firstPage = await request(
      identity(),
      "/admin/invites",
      undefined,
      database,
    );
    expect(firstPage.status).toBe(200);
    const body = (await firstPage.json()) as {
      items: Array<{ id: string; status: string }>;
      nextCursor: string | null;
    };
    expect(body.items).toHaveLength(20);
    expect(body.items.slice(0, 4).map((item) => item.status)).toEqual([
      "revoked",
      "exhausted",
      "expired",
      "active",
    ]);
    expect(body.nextCursor).toEqual(expect.any(String));
    expect(captured[0]?.sql).toContain(
      "ORDER BY i.created_at DESC, i.id DESC",
    );
    expect(captured[0]?.sql).not.toContain("token_hash");
    expect(captured[0]?.sql).not.toContain("email_hash");

    const nextPage = await request(
      identity(),
      `/admin/invites?cursor=${encodeURIComponent(body.nextCursor ?? "")}`,
      undefined,
      database,
    );
    expect(nextPage.status).toBe(200);
    expect(captured[1]?.sql).toContain("i.created_at < ?");
    expect(captured[1]?.bindings.slice(-1)).toEqual([21]);
  });

  it("rejects malformed cursors before querying the database", async () => {
    const response = await request(
      identity(),
      "/admin/invites?cursor=not-a-cursor",
      undefined,
      throwingDatabase(),
    );
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({
      error: { code: "INVALID_CURSOR" },
    });
  });
});

describe("admin invite revocation", () => {
  it("revokes and audits through one guarded batch", async () => {
    const state = revokeDatabase(null);
    const response = await request(
      identity(),
      "/admin/invites/invite-1",
      jsonMutation("PATCH", { revoked: true }),
      state.database,
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      invite: { id: "invite-1", status: "revoked" },
    });
    expect(state.batches).toHaveLength(1);
    expect(state.batches[0]?.[0]?.sql).toContain("revoked_at IS NULL");
    expect(state.batches[0]?.[1]?.sql).toContain("WHERE changes() = 1");
    expect(state.batches[0]?.[1]?.sql).toContain("invite.revoke");
  });

  it("treats an already revoked invitation as an idempotent success", async () => {
    const state = revokeDatabase(1_700_000_100);
    const response = await request(
      identity(),
      "/admin/invites/invite-1",
      jsonMutation("PATCH", { revoked: true }),
      state.database,
    );
    expect(response.status).toBe(200);
    expect(state.batches).toHaveLength(0);
  });
});
