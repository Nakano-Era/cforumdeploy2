import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { RequestIdentity } from "@/worker/auth/session";
import type { AppEnv, Bindings } from "@/worker/env";
import forumRoutes from "@/worker/routes/forum";

interface CapturedQuery {
  sql: string;
  bindings: unknown[];
}

function feedDatabase(captured: CapturedQuery[]): D1Database {
  const feedRow = {
    id: "topic-1",
    first_post_id: "post-1",
    slug: "topic-1",
    title: "One topic",
    excerpt: "Excerpt",
    category_id: "category-1",
    category_slug: "general",
    category_name: "General",
    category_color: "#123456",
    category_acl_mode: "open",
    effective_min_view_level: 0,
    author_id: "author-1",
    username: "author",
    display_name: "Author",
    author_trust_level: 1,
    tags_json: "[]",
    reply_count: 1,
    like_count: 2,
    unique_replier_count: 1,
    bumped_at: 100,
    last_poster_name: "Author",
    pinned: 0,
    featured: 0,
    locked: 0,
    bookmarked: 1,
    unread_posts: 0,
    followed: 0,
    new_to_viewer: 0,
    hot_score: 0,
    public_to_guest: 1,
  };
  return {
    prepare(sql: string) {
      let bindings: unknown[] = [];
      const statement = {
        sql,
        bind(...values: unknown[]) {
          bindings = values;
          return statement;
        },
        async all() {
          captured.push({ sql, bindings });
          if (sql.includes("AS topic_count")) {
            return {
              success: true,
              results: [
                {
                  category_id: "category-1",
                  topic_count: 7,
                  unread_count: 2,
                },
              ],
              meta: {},
            };
          }
          // Model two post-level bookmarks in the same topic. The former JOIN
          // shape would duplicate the topic row; EXISTS keeps one card.
          const results = sql.includes("LEFT JOIN bookmarks")
            ? [feedRow, feedRow]
            : [feedRow];
          return { success: true, results, meta: {} };
        },
        async first() {
          captured.push({ sql, bindings });
          if (sql.includes("FROM notifications")) return { count: 0 };
          if (sql.includes("AS members_online")) {
            return {
              members_online: 3,
              new_topics_today: 4,
              replies_today: 12,
              active_members_this_week: 9,
            };
          }
          return null;
        },
        async run() {
          return { success: true, results: [], meta: { changes: 1 } };
        },
      };
      return statement;
    },
    async batch() {
      return [
        {
          success: true,
          results: [
            {
              id: "category-1",
              slug: "general",
              name: "General",
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
            },
          ],
          meta: {},
        },
        { success: true, results: [], meta: {} },
      ] as D1Result[];
    },
  } as unknown as D1Database;
}

function bindings(database: D1Database): Bindings {
  return { CFORUM_DB: database } as Bindings;
}

const identity: RequestIdentity = {
  viewer: {
    userId: "user-1",
    role: "member",
    status: "active",
    trustLevel: 1,
    groupIds: new Set(),
    moderatedCategoryIds: new Set(),
  },
  session: {
    id: "session-1",
    userId: "user-1",
    csrfHash: "hash",
    expiresAt: 2_000_000_000,
  },
};

describe("feed bookmark projection", () => {
  it("keeps one topic card when the user bookmarked multiple posts", async () => {
    const captured: CapturedQuery[] = [];
    const app = new Hono<AppEnv>();
    app.use("*", async (context, next) => {
      context.set("requestId", "request-1");
      context.set("identity", identity);
      await next();
    });
    app.route("/", forumRoutes);

    const response = await app.request(
      "https://forum.example.com/feed",
      undefined,
      bindings(feedDatabase(captured)),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      topics: Array<{ id: string; bookmarked: boolean }>;
      pulse: {
        membersOnline: number;
        newTopicsToday: number;
        repliesToday: number;
        activeMembersThisWeek: number;
      };
      categories: Array<{
        id: string;
        topicCount: number;
        unreadCount: number;
      }>;
    };
    expect(body.topics).toHaveLength(1);
    expect(body.topics[0]).toMatchObject({
      id: "topic-1",
      bookmarked: true,
    });
    expect(body.pulse).toEqual({
      membersOnline: 3,
      newTopicsToday: 4,
      repliesToday: 12,
      activeMembersThisWeek: 9,
    });
    expect(body.categories[0]).toMatchObject({
      id: "category-1",
      topicCount: 7,
      unreadCount: 2,
    });

    const feedQuery = captured[0];
    expect(feedQuery?.sql).toContain("CASE WHEN EXISTS");
    expect(feedQuery?.sql).toContain("FROM bookmarks feed_bookmark");
    expect(feedQuery?.sql).not.toContain("LEFT JOIN bookmarks");
    expect(feedQuery?.bindings.slice(0, 4)).toEqual([
      "user-1",
      "user-1",
      "user-1",
      "user-1",
    ]);
  });

  it.each([
    ["latest", "t.bumped_at DESC, t.id DESC"],
    ["hot", "t.hot_score DESC, t.id DESC"],
    ["following", "t.bumped_at DESC, t.id DESC"],
    ["unread", "t.bumped_at DESC, t.id DESC"],
  ])("builds a valid order for the %s tab", async (tab, expectedOrder) => {
    const captured: CapturedQuery[] = [];
    const app = new Hono<AppEnv>();
    app.use("*", async (context, next) => {
      context.set("requestId", "request-1");
      context.set("identity", identity);
      await next();
    });
    app.route("/", forumRoutes);

    const response = await app.request(
      `https://forum.example.com/feed?tab=${tab}`,
      undefined,
      bindings(feedDatabase(captured)),
    );

    expect(response.status).toBe(200);
    const feedQuery = captured.find((query) =>
      query.sql.includes("JOIN posts first_post"),
    );
    expect(feedQuery?.sql).toContain(`ORDER BY ${expectedOrder}`);
    expect(feedQuery?.sql).not.toContain("ORDER BY 0");
  });
});
