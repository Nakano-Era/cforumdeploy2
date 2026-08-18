import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { RequestIdentity } from "@/worker/auth/session";
import type { AppEnv, Bindings } from "@/worker/env";
import forumRoutes from "@/worker/routes/forum";

interface FakeStatement {
  sql: string;
  bindings: unknown[];
  bind(...values: unknown[]): FakeStatement;
  all<T>(): Promise<D1Result<T>>;
  first<T>(): Promise<T | null>;
}

interface PinDatabaseState {
  exists: boolean;
  pinnedAt: number | null;
  audits: string[];
  batches: FakeStatement[][];
}

function identity(options: {
  role?: "member" | "moderator" | "admin";
  status?: "active" | "silenced";
  session?: boolean;
} = {}): RequestIdentity {
  const userId = "admin-1";
  return {
    viewer: {
      userId,
      role: options.role ?? "admin",
      status: options.status ?? "active",
      trustLevel: 4,
      groupIds: new Set(),
      moderatedCategoryIds: new Set(),
    },
    session:
      options.session === false
        ? null
        : {
            id: "session-1",
            userId,
            csrfHash: "csrf-hash",
            expiresAt: 2_000_000_000,
          },
  };
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

function pinDatabase(input: {
  exists?: boolean;
  pinnedAt?: number | null;
} = {}): { database: D1Database; state: PinDatabaseState } {
  const state: PinDatabaseState = {
    exists: input.exists ?? true,
    pinnedAt: input.pinnedAt ?? null,
    audits: [],
    batches: [],
  };

  const database = {
    prepare(sql: string) {
      const statement: FakeStatement = {
        sql,
        bindings: [],
        bind(...values: unknown[]) {
          statement.bindings = values;
          return statement;
        },
        async first<T>() {
          if (sql.includes("author.trust_level AS author_trust_level")) {
            if (!state.exists) return null;
            return {
              id: "topic-1",
              category_id: "category-1",
              author_id: "author-1",
              min_view_level: 0,
              effective_min_view_level: 0,
              author_qualified_visibility_level: 0,
              author_downgrade_locked: 0,
              status: "open",
              author_trust_level: 1,
            } as T;
          }
          if (sql.includes("FROM categories WHERE id")) {
            return {
              id: "category-1",
              slug: "general",
              name: "综合讨论",
              description: "",
              color: "#123456",
              state: "active",
              acl_mode: "open",
              min_view_level: 0,
              min_reply_level: 0,
              min_create_level: 0,
              allowed_topic_min_level_max: 4,
              require_topic_approval: 0,
              require_reply_approval: 0,
              allow_images: 1,
            } as T;
          }
          throw new Error(`unexpected first query: ${sql}`);
        },
        async all<T>() {
          if (sql.includes("FROM category_permissions")) {
            return {
              success: true,
              results: [],
              meta: {},
            } as unknown as D1Result<T>;
          }
          throw new Error(`unexpected all query: ${sql}`);
        },
      };
      return statement as unknown as D1PreparedStatement;
    },
    async batch(statements: D1PreparedStatement[]) {
      const fakeStatements = statements as unknown as FakeStatement[];
      state.batches.push(fakeStatements);
      const first = fakeStatements[0];
      if (first?.sql.includes("UPDATE topics")) {
        const desired = first.sql.includes("SET pinned_at = ?1");
        const changed =
          state.exists &&
          (desired ? state.pinnedAt === null : state.pinnedAt !== null);
        if (changed) {
          state.pinnedAt = desired ? Number(first.bindings[0]) : null;
          state.audits.push(String(fakeStatements[1]?.bindings[3]));
        }
        return [
          { success: true, results: [], meta: { changes: changed ? 1 : 0 } },
          { success: true, results: [], meta: { changes: changed ? 1 : 0 } },
          {
            success: true,
            results: state.exists
              ? [{ id: "topic-1", pinned_at: state.pinnedAt }]
              : [],
            meta: {},
          },
        ] as unknown as D1Result[];
      }
      if (first?.sql.includes("t.id, t.slug, t.title")) {
        return [
          {
            success: true,
            results: [
              {
                id: "topic-1",
                slug: "topic-1",
                title: "测试主题",
                status: "open",
                min_view_level: 0,
                effective_min_view_level: 0,
                reply_count: 0,
                like_count: 0,
                pinned_at: state.pinnedAt,
                bumped_at: 100,
                created_at: 90,
                category_id: "category-1",
                category_slug: "general",
                category_name: "综合讨论",
                category_color: "#123456",
                author_id: "author-1",
                username: "author",
                display_name: "作者",
                trust_level: 1,
                avatar_upload_id: null,
              },
            ],
            meta: {},
          },
          { success: true, results: [], meta: {} },
          { success: true, results: [], meta: {} },
        ] as unknown as D1Result[];
      }
      throw new Error(`unexpected batch query: ${first?.sql ?? "missing"}`);
    },
  } as unknown as D1Database;

  return { database, state };
}

function throwingDatabase(): D1Database {
  return {
    prepare() {
      throw new Error("database should not be accessed");
    },
  } as unknown as D1Database;
}

function bindings(database: D1Database): Bindings {
  return { CFORUM_DB: database } as Bindings;
}

function app(requestIdentity: RequestIdentity) {
  const testApp = new Hono<AppEnv>();
  testApp.use("*", async (context, next) => {
    context.set("requestId", "request-1");
    context.set("identity", requestIdentity);
    await next();
  });
  testApp.route("/", forumRoutes);
  return testApp;
}

function setPinned(
  requestIdentity: RequestIdentity,
  database: D1Database,
  desired: boolean,
) {
  return app(requestIdentity).request(
    "https://forum.example.com/topics/topic-1/pin",
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ desired }),
    },
    bindings(database),
  );
}

describe("topic pinning", () => {
  it("requires a session belonging to an active administrator", async () => {
    const unauthenticated = await setPinned(
      identity({ session: false }),
      throwingDatabase(),
      true,
    );
    expect(unauthenticated.status).toBe(401);

    const member = await setPinned(
      identity({ role: "member" }),
      throwingDatabase(),
      true,
    );
    expect(member.status).toBe(403);

    const inactiveAdmin = await setPinned(
      identity({ status: "silenced" }),
      throwingDatabase(),
      true,
    );
    expect(inactiveAdmin.status).toBe(403);
  });

  it("sets and clears the state idempotently and audits only real changes", async () => {
    const { database, state } = pinDatabase();

    const pinned = await setPinned(identity(), database, true);
    expect(pinned.status).toBe(200);
    await expect(pinned.json()).resolves.toMatchObject({
      topic: { id: "topic-1", pinned: true },
      changed: true,
    });

    const pinnedRetry = await setPinned(identity(), database, true);
    await expect(pinnedRetry.json()).resolves.toMatchObject({
      topic: { pinned: true },
      changed: false,
    });

    const unpinned = await setPinned(identity(), database, false);
    await expect(unpinned.json()).resolves.toMatchObject({
      topic: { pinned: false },
      changed: true,
    });

    const unpinnedRetry = await setPinned(identity(), database, false);
    await expect(unpinnedRetry.json()).resolves.toMatchObject({
      topic: { pinned: false },
      changed: false,
    });

    expect(state.audits).toEqual(["topic.pin", "topic.unpin"]);
    expect(state.batches[0]?.[0]?.sql).toContain("pinned_at IS NULL");
    expect(state.batches[0]?.[1]?.sql).toContain("changes() = 1");
    expect(state.batches[2]?.[0]?.sql).toContain("pinned_at IS NOT NULL");
    expect(state.batches[0]?.[1]?.bindings.slice(6, 8)).toEqual([
      JSON.stringify({ pinned: false }),
      JSON.stringify({ pinned: true }),
    ]);
  });

  it("returns 404 without an audit for a missing or ineligible topic", async () => {
    const { database, state } = pinDatabase({ exists: false });
    const response = await setPinned(identity(), database, true);
    expect(response.status).toBe(404);
    expect(state.audits).toEqual([]);
  });

  it("projects the pinned state in topic detail responses", async () => {
    const { database, state } = pinDatabase({ pinnedAt: 123 });
    const response = await app(guestIdentity).request(
      "https://forum.example.com/topics/topic-1",
      undefined,
      bindings(database),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { topic: { pinned: boolean } };
    expect(body.topic.pinned).toBe(true);
    expect(state.batches[0]?.[0]?.sql).toContain("t.pinned_at");
  });
});
