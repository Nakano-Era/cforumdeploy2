import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { RequestIdentity } from "@/worker/auth/session";
import type { AppEnv, Bindings } from "@/worker/env";
import adminManagementRoutes, {
  adminCategoryCreateSchema,
  adminUserPatchSchema,
} from "@/worker/routes/admin-management";

interface FakeStatement {
  sql: string;
  bindings: unknown[];
  bind(...values: unknown[]): FakeStatement;
  all<T>(): Promise<D1Result<T>>;
  first<T>(): Promise<T | null>;
}

interface FakeUserRow {
  id: string;
  username: string;
  display_name: string;
  email: string | null;
  role: "member" | "moderator" | "admin";
  trust_level: number;
  level_locked: number;
  status: "pending" | "active" | "silenced" | "suspended" | "deleted";
  next_level_review_at: number | null;
  created_at: number;
  updated_at: number;
}

interface FakeCategoryRow {
  id: string;
  slug: string;
  name: string;
  description: string;
  color: string;
  state: "active" | "archived" | "deleted";
  acl_mode: "open" | "restricted";
  min_view_level: number;
  min_create_level: number;
  min_reply_level: number;
  allowed_topic_min_level_max: number;
  allow_images: number;
  require_topic_approval: number;
  require_reply_approval: number;
  position: number;
  created_at: number;
  updated_at: number;
}

const member: FakeUserRow = {
  id: "member-1",
  username: "lin",
  display_name: "林同学",
  email: "lin@example.com",
  role: "member",
  trust_level: 1,
  level_locked: 0,
  status: "active",
  next_level_review_at: 100,
  created_at: 10,
  updated_at: 10,
};

const category: FakeCategoryRow = {
  id: "category-1",
  slug: "general",
  name: "综合讨论",
  description: "欢迎交流",
  color: "#336699",
  state: "active",
  acl_mode: "open",
  min_view_level: 0,
  min_create_level: 1,
  min_reply_level: 0,
  allowed_topic_min_level_max: 4,
  allow_images: 1,
  require_topic_approval: 0,
  require_reply_approval: 0,
  position: 0,
  created_at: 10,
  updated_at: 10,
};

function database(options: {
  users?: FakeUserRow[];
  categories?: FakeCategoryRow[];
  firstBatchChanges?: number;
  captured?: FakeStatement[][];
  afterBatch?: (users: FakeUserRow[]) => void;
} = {}): D1Database {
  const users = (options.users ?? [member]).map((row) => ({ ...row }));
  const categories = (options.categories ?? [category]).map((row) => ({
    ...row,
  }));
  const firstBatchChanges = options.firstBatchChanges ?? 1;

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
          const results = sql.includes("FROM categories")
            ? categories
            : sql.includes("FROM users u")
              ? users
              : [];
          return {
            success: true,
            results: results as T[],
            meta: {},
          } as D1Result<T>;
        },
        async first<T>() {
          if (sql.includes("FROM users u")) {
            const userId = String(statement.bindings[0]);
            return (users.find((row) => row.id === userId) ?? null) as T | null;
          }
          if (sql.includes("FROM categories")) {
            const categoryId = String(statement.bindings[0]);
            return (categories.find((row) => row.id === categoryId) ??
              null) as T | null;
          }
          return null;
        },
      };
      return statement as unknown as D1PreparedStatement;
    },
    async batch(statements: D1PreparedStatement[]) {
      const fakeStatements = statements as unknown as FakeStatement[];
      options.captured?.push(fakeStatements);
      const first = fakeStatements[0];
      if (
        firstBatchChanges === 1 &&
        first?.sql.includes("UPDATE users")
      ) {
        const userId = String(first.bindings[0]);
        const row = users.find((candidate) => candidate.id === userId);
        if (row) {
          row.role = first.bindings[1] as FakeUserRow["role"];
          row.trust_level = Number(first.bindings[2]);
          row.level_locked = Number(first.bindings[3]);
          row.next_level_review_at = first.bindings[4] as number | null;
          row.updated_at = Number(first.bindings[5]);
        }
      }
      if (
        firstBatchChanges === 1 &&
        first?.sql.includes("INSERT OR IGNORE INTO categories")
      ) {
        const highestPosition = categories.reduce(
          (highest, item) => Math.max(highest, item.position),
          -1,
        );
        categories.push({
          id: String(first.bindings[0]),
          slug: String(first.bindings[1]),
          name: String(first.bindings[2]),
          description: String(first.bindings[3]),
          color: String(first.bindings[4]),
          state: "active",
          acl_mode: first.bindings[5] as FakeCategoryRow["acl_mode"],
          min_view_level: Number(first.bindings[6]),
          min_create_level: Number(first.bindings[7]),
          min_reply_level: Number(first.bindings[8]),
          allowed_topic_min_level_max: Number(first.bindings[9]),
          require_topic_approval: Number(first.bindings[10]),
          require_reply_approval: Number(first.bindings[11]),
          allow_images: Number(first.bindings[12]),
          position: highestPosition + 1,
          created_at: Number(first.bindings[13]),
          updated_at: Number(first.bindings[13]),
        });
      }
      options.afterBatch?.(users);
      return fakeStatements.map((_, index) => ({
        success: true,
        results: [],
        meta: { changes: index === 0 ? firstBatchChanges : firstBatchChanges },
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

function identity(options: {
  session?: boolean;
  role?: "member" | "moderator" | "admin";
} = {}): RequestIdentity {
  const role = options.role ?? "admin";
  return {
    viewer: {
      userId: "admin-1",
      role,
      status: "active",
      trustLevel: 4,
      groupIds: new Set(),
      moderatedCategoryIds: new Set(),
    },
    session:
      options.session === false
        ? null
        : {
            id: "session-1",
            userId: "admin-1",
            csrfHash: "x",
            expiresAt: 999,
          },
  };
}

function app(requestIdentity: RequestIdentity) {
  const testApp = new Hono<AppEnv>();
  testApp.use("*", async (context, next) => {
    context.set("identity", requestIdentity);
    context.set("requestId", "request-1");
    await next();
  });
  testApp.route("/", adminManagementRoutes);
  return testApp;
}

describe("admin management schemas", () => {
  it("accepts partial user updates and rejects empty updates", () => {
    expect(adminUserPatchSchema.safeParse({ role: "admin" }).success).toBe(true);
    expect(adminUserPatchSchema.safeParse({ trustLevel: 3 }).success).toBe(true);
    expect(adminUserPatchSchema.safeParse({}).success).toBe(false);
  });

  it("keeps category write levels consistent with its view level", () => {
    expect(
      adminCategoryCreateSchema.safeParse({
        slug: "staff-room",
        name: "成员区",
        minViewLevel: 2,
        minCreateLevel: 1,
      }).success,
    ).toBe(false);
    expect(
      adminCategoryCreateSchema.safeParse({
        slug: "staff-room",
        name: "成员区",
        minViewLevel: 2,
        minCreateLevel: 2,
        minReplyLevel: 2,
      }).success,
    ).toBe(true);
  });
});

describe("admin user management routes", () => {
  it("requires an active administrator session", async () => {
    const unauthenticated = await app(identity({ session: false })).request(
      "https://forum.example.com/admin/users",
      undefined,
      bindings(database()),
    );
    expect(unauthenticated.status).toBe(401);

    const moderator = await app(identity({ role: "moderator" })).request(
      "https://forum.example.com/admin/users",
      undefined,
      bindings(database()),
    );
    expect(moderator.status).toBe(403);
  });

  it("lists the fields needed by the member administration screen", async () => {
    const response = await app(identity()).request(
      "https://forum.example.com/admin/users?q=lin",
      undefined,
      bindings(database()),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      items: Array<Record<string, unknown>>;
      nextCursor: string | null;
    };
    expect(body.nextCursor).toBeNull();
    expect(body.items[0]).toMatchObject({
      id: "member-1",
      username: "lin",
      displayName: "林同学",
      email: "lin@example.com",
      role: "member",
      trustLevel: 1,
      levelLocked: false,
      status: "active",
    });
    expect(body.items[0]?.createdAt).toBe(new Date(10_000).toISOString());
  });

  it("can appoint another administrator and records an audit", async () => {
    const captured: FakeStatement[][] = [];
    const response = await app(identity()).request(
      "https://forum.example.com/admin/users/member-1",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ role: "admin" }),
      },
      bindings(database({ captured })),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { user: { role: string } };
    expect(body.user.role).toBe("admin");
    expect(captured[0]).toHaveLength(2);
    expect(captured[0]?.[0]?.sql).toContain("other_admin.role = 'admin'");
    expect(captured[0]?.[1]?.sql).toContain("user.admin_update");
  });

  it("locks a manually changed level and writes history plus notification", async () => {
    const captured: FakeStatement[][] = [];
    const response = await app(identity()).request(
      "https://forum.example.com/admin/users/member-1",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ trustLevel: 3 }),
      },
      bindings(database({ captured })),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      user: { trustLevel: number; levelLocked: boolean };
    };
    expect(body.user).toMatchObject({ trustLevel: 3, levelLocked: true });
    expect(captured[0]).toHaveLength(4);
    expect(captured[0]?.[1]?.sql).toContain("user_level_history");
    expect(captured[0]?.[1]?.sql).toContain("admin_manual");
    expect(captured[0]?.[2]?.sql).toContain("notifications");
    expect(captured[0]?.[3]?.sql).toContain("audit_logs");
  });

  it("keeps Lv4 manually locked even when a direct request asks to unlock it", async () => {
    const captured: FakeStatement[][] = [];
    const response = await app(identity()).request(
      "https://forum.example.com/admin/users/member-1",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ trustLevel: 4, levelLocked: false }),
      },
      bindings(database({ captured })),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      user: { trustLevel: number; levelLocked: boolean; nextLevelReviewAt: string | null };
    };
    expect(body.user).toMatchObject({
      trustLevel: 4,
      levelLocked: true,
      nextLevelReviewAt: null,
    });
    expect(captured[0]?.[0]?.bindings[3]).toBe(1);
    expect(captured[0]?.[0]?.bindings[4]).toBeNull();
  });

  it("refuses to remove the last active administrator", async () => {
    const adminRow: FakeUserRow = {
      ...member,
      id: "admin-1",
      username: "owner",
      role: "admin",
      trust_level: 4,
      level_locked: 1,
    };
    const response = await app(identity()).request(
      "https://forum.example.com/admin/users/admin-1",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ role: "member" }),
      },
      bindings(database({ users: [adminRow], firstBatchChanges: 0 })),
    );
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: { code: "LAST_ACTIVE_ADMIN_REQUIRED" },
    });
  });

  it("reports a concurrent user change instead of mislabeling it as the last administrator", async () => {
    const adminRow: FakeUserRow = {
      ...member,
      id: "admin-1",
      username: "owner",
      role: "admin",
      trust_level: 4,
      level_locked: 1,
    };
    const response = await app(identity()).request(
      "https://forum.example.com/admin/users/admin-1",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ role: "member" }),
      },
      bindings(database({
        users: [adminRow],
        firstBatchChanges: 0,
        afterBatch(users) {
          if (users[0]) {
            users[0] = {
              ...users[0],
              trust_level: 3,
              updated_at: 11,
            };
          }
        },
      })),
    );
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: { code: "USER_CHANGED" },
    });
  });
});

describe("admin category management routes", () => {
  it("returns the category administration fields", async () => {
    const response = await app(identity()).request(
      "https://forum.example.com/admin/categories",
      undefined,
      bindings(database()),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      items: Array<Record<string, unknown>>;
    };
    expect(body.items[0]).toMatchObject({
      id: "category-1",
      slug: "general",
      name: "综合讨论",
      description: "欢迎交流",
      color: "#336699",
      aclMode: "open",
      minViewLevel: 0,
      minCreateLevel: 1,
      minReplyLevel: 0,
      allowedTopicMinLevelMax: 4,
      allowImages: true,
    });
  });

  it("creates a member-only category with explicit authenticated grants", async () => {
    const captured: FakeStatement[][] = [];
    const response = await app(identity()).request(
      "https://forum.example.com/admin/categories",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          slug: "members-only",
          name: "成员专区",
          description: "仅成员可见",
          color: "#123abc",
          aclMode: "restricted",
          minViewLevel: 0,
          minCreateLevel: 1,
          minReplyLevel: 0,
          allowedTopicMinLevelMax: 4,
          allowImages: false,
        }),
      },
      bindings(database({ captured })),
    );
    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      category: Record<string, unknown>;
    };
    expect(body.category).toMatchObject({
      slug: "members-only",
      aclMode: "restricted",
      allowImages: false,
      position: 1,
    });
    expect(captured[0]).toHaveLength(5);
    expect(captured[0]?.[0]?.sql).toContain("INSERT OR IGNORE INTO categories");
    for (const statement of captured[0]?.slice(1, 4) ?? []) {
      expect(statement.sql).toContain("'authenticated'");
    }
    expect(captured[0]?.slice(1, 4).map((item) => item.bindings[2])).toEqual([
      "see",
      "reply",
      "create",
    ]);
    expect(captured[0]?.[4]?.sql).toContain("category.create");
  });

  it("reports duplicate slugs without creating an audit entry", async () => {
    const response = await app(identity()).request(
      "https://forum.example.com/admin/categories",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slug: "general", name: "重复板块" }),
      },
      bindings(database({ firstBatchChanges: 0 })),
    );
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: { code: "CATEGORY_SLUG_TAKEN" },
    });
  });
});
