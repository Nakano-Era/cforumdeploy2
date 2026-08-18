import { Hono } from "hono";
import removeMarkdown from "remove-markdown";
import { z } from "zod";
import type { TrustLevel } from "@/shared/domain";
import type { AppEnv } from "@/worker/env";
import {
  canViewCategory,
  evaluateCreateTopic,
  evaluateReplyTopic,
  evaluateViewTopic,
} from "@/worker/permissions/policy";
import { topicVisibilityScope } from "@/worker/permissions/visibility-scope";
import {
  getCategory,
  getNumericSetting,
  getTopicAggregate,
  listCategories,
} from "@/worker/repositories/forum";
import { nowSeconds } from "@/worker/security/crypto";
import { avatarUrl } from "@/worker/media/avatar-url";
import {
  recordTopicRead,
  replyCreatedActivityStatement,
  topicCreatedActivityStatement,
} from "@/worker/trust/activity";

const router = new Hono<AppEnv>();
const idSchema = z.string().min(1).max(80).regex(/^[A-Za-z0-9_-]+$/);
const trustLevelSchema = z.coerce.number().int().min(0).max(4);

const feedQuerySchema = z.object({
  tab: z.enum(["all", "latest", "hot", "following", "unread"]).default("all"),
  cursor: z.string().max(512).optional(),
  category: z.string().min(1).max(80).optional(),
  tag: z.string().min(1).max(60).optional(),
  min_level: trustLevelSchema.optional(),
  q: z.string().trim().min(2).max(80).optional(),
});

const createTopicSchema = z.object({
  categoryId: idSchema,
  title: z.string().trim().min(3).max(120),
  body: z
    .string()
    .min(1)
    .max(50_000)
    .refine((value) => value.trim().length > 0, "正文不能为空"),
  minViewLevel: trustLevelSchema,
});

const createReplySchema = z.object({
  body: z
    .string()
    .min(1)
    .max(50_000)
    .refine((value) => value.trim().length > 0, "回复不能为空"),
  replyToPostId: idSchema.optional(),
});

const topicPinSchema = z.object({ desired: z.boolean() }).strict();

interface FeedCursor {
  rank: number;
  value: number;
  id: string;
}

const feedCursorSchema = z.object({
  rank: z.number().int().min(0).max(1),
  value: z.number().finite(),
  id: idSchema,
});

function decodeCursor(value: string | undefined): FeedCursor | null {
  if (!value) return null;
  try {
    const json = atob(value.replaceAll("-", "+").replaceAll("_", "/"));
    const parsed = feedCursorSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function encodeCursor(cursor: FeedCursor): string {
  return btoa(JSON.stringify(cursor))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function plainExcerpt(markdown: string): string {
  return removeMarkdown(markdown, { useImgAltText: true })
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 280);
}

function isoFromSeconds(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

function initials(displayName: string): string {
  return [...displayName.trim()].slice(0, 1).join("") || "友";
}

const avatarTones = ["coral", "moss", "blue", "gold", "plum"] as const;

function avatarTone(id: string): (typeof avatarTones)[number] {
  let hash = 0;
  for (const character of id) hash = (hash * 31 + character.charCodeAt(0)) | 0;
  return avatarTones[Math.abs(hash) % avatarTones.length];
}

function escapeLikePrefix(value: string): string {
  return `${value.replace(/[\\%_]/g, "\\$&")}%`;
}

interface FeedRow {
  id: string;
  first_post_id: string;
  slug: string;
  title: string;
  excerpt: string;
  category_id: string;
  category_slug: string;
  category_name: string;
  category_color: string;
  category_acl_mode: "open" | "restricted";
  effective_min_view_level: TrustLevel;
  author_id: string;
  username: string;
  display_name: string;
  avatar_upload_id: string | null;
  author_trust_level: TrustLevel;
  tags_json: string;
  reply_count: number;
  like_count: number;
  unique_replier_count: number;
  bumped_at: number;
  last_poster_name: string;
  pinned: number;
  featured: number;
  locked: number;
  bookmarked: number;
  unread_posts: number;
  followed: number;
  new_to_viewer: number;
  hot_score: number;
  public_to_guest: number;
}

interface CommunityPulseRow {
  members_online: number;
  new_topics_today: number;
  replies_today: number;
  active_members_this_week: number;
}

interface CategoryFeedCountRow {
  category_id: string;
  topic_count: number;
  unread_count: number;
}

interface TopicDetailRow {
  id: string;
  slug: string;
  title: string;
  status: TopicPolicyState;
  min_view_level: TrustLevel;
  effective_min_view_level: TrustLevel;
  reply_count: number;
  like_count: number;
  pinned_at: number | null;
  bumped_at: number;
  created_at: number;
  category_id: string;
  category_slug: string;
  category_name: string;
  category_color: string;
  author_id: string;
  username: string;
  display_name: string;
  avatar_upload_id: string | null;
  trust_level: TrustLevel;
}

type TopicPolicyState = "open" | "locked" | "archived" | "deleted" | "pending";

interface PostDetailRow {
  id: string;
  post_number: number;
  raw_markdown: string;
  like_count: number;
  liked: number;
  created_at: number;
  updated_at: number;
  author_id: string;
  username: string;
  display_name: string;
  avatar_upload_id: string | null;
  trust_level: TrustLevel;
}

router.get("/categories", async (context) => {
  const viewer = context.get("identity").viewer;
  const categories = (await listCategories(context.env.CFORUM_DB)).filter((category) =>
    canViewCategory(viewer, category),
  );
  const scope = topicVisibilityScope(viewer);
  const countsResult = await context.env.CFORUM_DB.prepare(
    `SELECT c.id AS category_id, COUNT(*) AS topic_count
     FROM topics t
     JOIN categories c ON c.id = t.category_id
     WHERE ${scope.clause}
     GROUP BY c.id`,
  )
    .bind(...scope.bindings)
    .all<{ category_id: string; topic_count: number }>();
  const counts = new Map(
    countsResult.results.map((row) => [row.category_id, row.topic_count]),
  );

  return context.json({
    categories: categories.map((category) => ({
      id: category.id,
      slug: category.slug,
      name: category.name,
      description: category.description,
      accent: category.color,
      topicCount: counts.get(category.id) ?? 0,
      unreadCount: 0,
      minViewLevel: category.minViewLevel,
      allowedTopicMinLevelMax: category.allowedTopicMinLevelMax,
      allowImages: category.allowImages,
      canCreate: evaluateCreateTopic(viewer, category, 0).allowed,
    })),
  });
});

router.get("/feed", async (context) => {
  const parsed = feedQuerySchema.safeParse(context.req.query());
  if (!parsed.success) {
    return context.json({ error: { code: "INVALID_QUERY" } }, 422);
  }
  const identity = context.get("identity");
  const { viewer } = identity;
  if (
    (parsed.data.tab === "following" || parsed.data.tab === "unread") &&
    !viewer.userId
  ) {
    return context.json({ error: { code: "AUTHENTICATION_REQUIRED" } }, 401);
  }

  const scope = topicVisibilityScope(viewer);
  const viewerId = viewer.userId ?? "";
  const where = [scope.clause];
  const bindings: Array<string | number | null> = [
    viewerId,
    viewerId,
    viewerId,
    viewerId,
    ...scope.bindings,
  ];

  if (parsed.data.category) {
    where.push("c.slug = ?");
    bindings.push(parsed.data.category);
  }
  if (parsed.data.tag) {
    where.push(
      `EXISTS (
        SELECT 1 FROM topic_tags filter_tt
        JOIN tags filter_tag ON filter_tag.id = filter_tt.tag_id
        WHERE filter_tt.topic_id = t.id AND filter_tag.slug = ?
      )`,
    );
    bindings.push(parsed.data.tag);
  }
  if (parsed.data.min_level !== undefined) {
    where.push("t.effective_min_view_level <= ?");
    bindings.push(parsed.data.min_level);
  }
  if (parsed.data.q) {
    where.push("t.title LIKE ? ESCAPE '\\' COLLATE NOCASE");
    bindings.push(escapeLikePrefix(parsed.data.q));
  }
  if (parsed.data.tab === "following") {
    where.push(
      `(COALESCE(tf.level, cf.level, 'normal') IN ('watch', 'track', 'watch_first_post'))`,
    );
  }
  if (parsed.data.tab === "unread") {
    where.push("COALESCE(tr.last_read_post_number, 0) < t.last_post_number");
  }

  const rankExpression =
    parsed.data.tab === "all"
      ? "CASE WHEN t.pinned_at IS NOT NULL THEN 1 ELSE 0 END"
      : "0";
  const valueExpression = parsed.data.tab === "hot" ? "t.hot_score" : "t.bumped_at";
  const cursor = decodeCursor(parsed.data.cursor);
  if (parsed.data.cursor && !cursor) {
    return context.json({ error: { code: "INVALID_CURSOR" } }, 422);
  }
  if (cursor) {
    where.push(
      `(
        ${rankExpression} < ? OR
        (${rankExpression} = ? AND (
          ${valueExpression} < ? OR
          (${valueExpression} = ? AND t.id < ?)
        ))
      )`,
    );
    bindings.push(cursor.rank, cursor.rank, cursor.value, cursor.value, cursor.id);
  }

  // A bare integer in ORDER BY is treated as a result-column position by
  // SQLite. `ORDER BY 0` therefore fails for every non-"all" tab instead of
  // behaving as a constant rank. Only include the pinned rank when it matters.
  const orderBy =
    parsed.data.tab === "all"
      ? `${rankExpression} DESC, ${valueExpression} DESC, t.id DESC`
      : `${valueExpression} DESC, t.id DESC`;
  bindings.push(21);
  const result = await context.env.CFORUM_DB.prepare(
    `SELECT
       t.id, first_post.id AS first_post_id, t.slug, t.title,
       first_post.plain_text_excerpt AS excerpt,
       c.id AS category_id, c.slug AS category_slug, c.name AS category_name,
       c.color AS category_color, c.acl_mode AS category_acl_mode,
       t.effective_min_view_level,
       author.id AS author_id, author.username, author.display_name,
       author.avatar_upload_id,
       author.trust_level AS author_trust_level,
       COALESCE((
         SELECT json_group_array(tag_name)
         FROM (
           SELECT tags.name AS tag_name
           FROM topic_tags tt
           JOIN tags ON tags.id = tt.tag_id
           WHERE tt.topic_id = t.id
           ORDER BY tags.name
         )
       ), '[]') AS tags_json,
       t.reply_count, t.like_count, t.unique_replier_count, t.bumped_at,
       COALESCE((
         SELECT last_author.display_name
         FROM posts last_post
         JOIN users last_author ON last_author.id = last_post.author_id
         WHERE last_post.topic_id = t.id AND last_post.status = 'published'
         ORDER BY last_post.post_number DESC
         LIMIT 1
       ), author.display_name) AS last_poster_name,
       CASE WHEN t.pinned_at IS NULL THEN 0 ELSE 1 END AS pinned,
       CASE WHEN t.featured_at IS NULL THEN 0 ELSE 1 END AS featured,
       CASE WHEN t.status = 'locked' OR t.author_downgrade_locked = 1 THEN 1 ELSE 0 END AS locked,
       CASE WHEN EXISTS (
         SELECT 1 FROM bookmarks feed_bookmark
         WHERE feed_bookmark.topic_id = t.id
           AND feed_bookmark.user_id = ?
       ) THEN 1 ELSE 0 END AS bookmarked,
       MAX(0, t.last_post_number - COALESCE(tr.last_read_post_number, 0)) AS unread_posts,
       CASE WHEN COALESCE(tf.level, cf.level, 'normal') IN ('watch', 'track', 'watch_first_post') THEN 1 ELSE 0 END AS followed,
       CASE WHEN tr.first_read_at IS NULL THEN 1 ELSE 0 END AS new_to_viewer,
       t.hot_score,
       CASE WHEN
         MAX(c.min_view_level, t.min_view_level, t.effective_min_view_level) = 0
         AND (
           c.acl_mode = 'open' OR EXISTS (
             SELECT 1 FROM category_permissions guest_cp
             WHERE guest_cp.category_id = c.id
               AND guest_cp.action = 'see'
               AND guest_cp.principal_type = 'everyone'
           )
         )
       THEN 1 ELSE 0 END AS public_to_guest
     FROM topics t
     JOIN categories c ON c.id = t.category_id
     JOIN users author ON author.id = t.author_id
     JOIN posts first_post ON first_post.topic_id = t.id AND first_post.post_number = 1
     LEFT JOIN topic_reads tr ON tr.topic_id = t.id AND tr.user_id = ?
     LEFT JOIN topic_follows tf ON tf.topic_id = t.id AND tf.user_id = ?
     LEFT JOIN category_follows cf ON cf.category_id = c.id AND cf.user_id = ?
     WHERE ${where.join(" AND ")}
     ORDER BY ${orderBy}
     LIMIT ?`,
  )
    .bind(...bindings)
    .all<FeedRow>();

  const pageRows = result.results.slice(0, 20);
  const hasMore = result.results.length > 20;
  const nextRow = hasMore ? pageRows.at(-1) : null;
  const generatedAt = nowSeconds();
  if (identity.session) {
    try {
      await context.env.CFORUM_DB.prepare(
        `UPDATE sessions
         SET last_seen_at = ?1
         WHERE id = ?2 AND last_seen_at < ?3`,
      )
        .bind(generatedAt, identity.session.id, generatedAt - 60)
        .run();
    } catch (error) {
      // Presence is informative only; a failed heartbeat must not make the
      // discussion feed unavailable.
      console.error("feed_presence_update_failed", {
        requestId: context.get("requestId"),
        name: error instanceof Error ? error.name : "unknown",
      });
    }
  }

  const dayStart = Math.floor(generatedAt / 86_400) * 86_400;
  const pulseStatement = context.env.CFORUM_DB.prepare(
    `SELECT
       (
         SELECT COUNT(DISTINCT online_session.user_id)
         FROM sessions online_session
         JOIN users online_user ON online_user.id = online_session.user_id
         WHERE online_session.revoked_at IS NULL
           AND online_session.expires_at > ?
           AND online_session.last_seen_at >= ?
           AND online_user.status IN ('active', 'silenced')
       ) AS members_online,
       (
         SELECT COUNT(*)
         FROM topics t
         JOIN categories c ON c.id = t.category_id
         WHERE ${scope.clause}
           AND t.created_at >= ?
       ) AS new_topics_today,
       (
         SELECT COUNT(*)
         FROM posts pulse_post
         JOIN topics t ON t.id = pulse_post.topic_id
         JOIN categories c ON c.id = t.category_id
         WHERE ${scope.clause}
           AND pulse_post.status = 'published'
           AND pulse_post.post_number > 1
           AND pulse_post.created_at >= ?
       ) AS replies_today,
       (
         SELECT COUNT(DISTINCT activity.user_id)
         FROM user_activity_daily activity
         JOIN users active_user ON active_user.id = activity.user_id
         WHERE activity.activity_date >= date(?, 'unixepoch', '-6 days')
           AND activity.active = 1
           AND active_user.status IN ('active', 'silenced')
       ) AS active_members_this_week`,
  ).bind(
    generatedAt,
    generatedAt - 5 * 60,
    ...scope.bindings,
    dayStart,
    ...scope.bindings,
    dayStart,
    dayStart,
  );

  const categoryCountsStatement = context.env.CFORUM_DB.prepare(
    `SELECT
       c.id AS category_id,
       COUNT(*) AS topic_count,
       SUM(
         CASE WHEN ? != ''
           AND COALESCE(category_read.last_read_post_number, 0) < t.last_post_number
         THEN 1 ELSE 0 END
       ) AS unread_count
     FROM topics t
     JOIN categories c ON c.id = t.category_id
     LEFT JOIN topic_reads category_read
       ON category_read.topic_id = t.id AND category_read.user_id = ?
     WHERE ${scope.clause}
     GROUP BY c.id`,
  )
    .bind(viewerId, viewerId, ...scope.bindings);

  const [
    categoryRecords,
    unreadNotificationRow,
    pulseRow,
    categoryCountResult,
  ] = await Promise.all([
    listCategories(context.env.CFORUM_DB),
    viewer.userId
      ? context.env.CFORUM_DB.prepare(
          `SELECT COUNT(*) AS count FROM notifications
           WHERE user_id = ?1 AND read_at IS NULL`,
        )
          .bind(viewer.userId)
          .first<{ count: number }>()
      : Promise.resolve(null),
    pulseStatement.first<CommunityPulseRow>(),
    categoryCountsStatement.all<CategoryFeedCountRow>(),
  ]);
  const categories = categoryRecords.filter((category) =>
    canViewCategory(viewer, category),
  );
  const categoryCounts = new Map(
    categoryCountResult.results.map((row) => [
      row.category_id,
      {
        topicCount: Number(row.topic_count ?? 0),
        unreadCount: Number(row.unread_count ?? 0),
      },
    ]),
  );

  const topics = pageRows.map((row) => ({
    id: row.id,
    firstPostId: row.first_post_id,
    slug: row.slug,
    title: row.title,
    excerpt: row.excerpt,
    category: {
      id: row.category_id,
      slug: row.category_slug,
      name: row.category_name,
      accent: row.category_color,
    },
    author: {
      id: row.author_id,
      displayName: row.display_name,
      handle: row.username,
      initials: initials(row.display_name),
      avatarTone: avatarTone(row.author_id),
      avatarUrl: avatarUrl(row.avatar_upload_id),
      trustLevel: row.author_trust_level,
    },
    tags: JSON.parse(row.tags_json) as string[],
    visibility:
      row.public_to_guest === 1
        ? { kind: "public" as const }
        : row.category_acl_mode === "restricted"
          ? {
              kind: "group" as const,
              label: "成员板块",
              minLevel: row.effective_min_view_level,
            }
          : {
              kind: "trust_level" as const,
              minLevel: row.effective_min_view_level,
            },
    replyCount: row.reply_count,
    likeCount: row.like_count,
    participantCount: row.unique_replier_count + 1,
    bumpedAt: isoFromSeconds(row.bumped_at),
    lastPosterName: row.last_poster_name,
    pinned: row.pinned === 1,
    featured: row.featured === 1,
    locked: row.locked === 1,
    bookmarked: row.bookmarked === 1,
    unreadPosts: viewer.userId ? row.unread_posts : 0,
    signals: {
      hot: row.hot_score >= 1,
      followed: row.followed === 1,
      newToViewer: viewer.userId ? row.new_to_viewer === 1 : false,
    },
  }));

  return context.json({
    viewer: viewer.userId
      ? {
          id: viewer.userId,
          displayName: "社区成员",
          trustLevel: viewer.trustLevel ?? 0,
          unreadNotifications: Number(unreadNotificationRow?.count ?? 0),
        }
      : null,
    topics,
    categories: categories.map((category) => ({
      id: category.id,
      slug: category.slug,
      name: category.name,
      description: category.description,
      accent: category.color,
      topicCount: categoryCounts.get(category.id)?.topicCount ?? 0,
      unreadCount: categoryCounts.get(category.id)?.unreadCount ?? 0,
      minViewLevel: category.minViewLevel,
      allowedTopicMinLevelMax: category.allowedTopicMinLevelMax,
      allowImages: category.allowImages,
      canCreate: evaluateCreateTopic(viewer, category, 0).allowed,
    })),
    pulse: {
      membersOnline: Number(pulseRow?.members_online ?? 0),
      newTopicsToday: Number(pulseRow?.new_topics_today ?? 0),
      repliesToday: Number(pulseRow?.replies_today ?? 0),
      activeMembersThisWeek: Number(pulseRow?.active_members_this_week ?? 0),
    },
    nextCursor:
      nextRow && hasMore
        ? encodeCursor({
            rank: parsed.data.tab === "all" && nextRow.pinned === 1 ? 1 : 0,
            value:
              parsed.data.tab === "hot" ? nextRow.hot_score : nextRow.bumped_at,
            id: nextRow.id,
          })
        : null,
    generatedAt: isoFromSeconds(generatedAt),
  });
});

router.post("/topics", async (context) => {
  const identity = context.get("identity");
  if (!identity.viewer.userId) {
    return context.json({ error: { code: "AUTHENTICATION_REQUIRED" } }, 401);
  }
  const parsed = createTopicSchema.safeParse(await context.req.json().catch(() => null));
  if (!parsed.success) {
    return context.json({ error: { code: "INVALID_INPUT" } }, 422);
  }
  const category = await getCategory(context.env.CFORUM_DB, parsed.data.categoryId);
  if (!category || !canViewCategory(identity.viewer, category)) {
    return context.json({ error: { code: "NOT_FOUND" } }, 404);
  }
  const requestedLevel = parsed.data.minViewLevel as TrustLevel;
  const decision = evaluateCreateTopic(identity.viewer, category, requestedLevel);
  if (!decision.allowed) {
    return context.json({ error: { code: "ACTION_NOT_ALLOWED" } }, 403);
  }

  const [reviewLimit, priorTopics] = await Promise.all([
    getNumericSetting(
      context.env.CFORUM_DB,
      "lv0_first_topics_review_count",
      3,
    ),
    context.env.CFORUM_DB.prepare(
      "SELECT COUNT(*) AS count FROM topics WHERE author_id = ?1",
    )
      .bind(identity.viewer.userId)
      .first<{ count: number }>(),
  ]);
  const reviewRequired =
    category.requireTopicApproval ||
    (identity.viewer.trustLevel === 0 &&
      Number(priorTopics?.count ?? 0) < reviewLimit);
  const now = nowSeconds();
  const topicId = crypto.randomUUID();
  const postId = crypto.randomUUID();
  const effectiveLevel = Math.max(
    category.minViewLevel,
    requestedLevel,
  ) as TrustLevel;
  const topicStatus = reviewRequired ? "pending" : "open";
  const approvalStatus = reviewRequired ? "pending" : "approved";
  const postStatus = reviewRequired ? "pending" : "published";
  const excerpt = plainExcerpt(parsed.data.body);
  const statements: D1PreparedStatement[] = [
    context.env.CFORUM_DB.prepare(
      `INSERT INTO topics(
         id, category_id, author_id, title, slug, min_view_level,
         effective_min_view_level, author_qualified_visibility_level,
         status, approval_status, bumped_at, created_at, updated_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7, ?8, ?9, ?10, ?10, ?10)`,
    ).bind(
      topicId,
      category.id,
      identity.viewer.userId,
      parsed.data.title,
      `topic-${topicId.slice(0, 8)}`,
      requestedLevel,
      effectiveLevel,
      topicStatus,
      approvalStatus,
      now,
    ),
    context.env.CFORUM_DB.prepare(
      `INSERT INTO posts(
         id, topic_id, author_id, post_number, raw_markdown,
         plain_text_excerpt, status, created_at, updated_at
       ) VALUES (?1, ?2, ?3, 1, ?4, ?5, ?6, ?7, ?7)`,
    ).bind(
      postId,
      topicId,
      identity.viewer.userId,
      parsed.data.body,
      excerpt,
      postStatus,
      now,
    ),
    topicCreatedActivityStatement(context.env.CFORUM_DB, {
      userId: identity.viewer.userId,
      now,
      published: !reviewRequired,
    }),
    context.env.CFORUM_DB.prepare(
      `INSERT INTO audit_logs(
         id, occurred_at, actor_user_id, actor_role, action, target_type,
         target_id, category_id, request_id, after_json
       ) VALUES (?1, ?2, ?3, ?4, 'topic.create', 'topic', ?5, ?6, ?7, ?8)`,
    ).bind(
      crypto.randomUUID(),
      now,
      identity.viewer.userId,
      identity.viewer.role,
      topicId,
      category.id,
      context.get("requestId"),
      JSON.stringify({ minViewLevel: requestedLevel, reviewRequired }),
    ),
  ];
  if (reviewRequired) {
    statements.push(
      context.env.CFORUM_DB.prepare(
        `INSERT INTO review_items(
           id, type, category_id, submitted_by, target_user_id,
           target_topic_id, target_post_id, trigger_reason,
           content_snapshot_json, priority, created_at
         ) VALUES (?1, 'first_post', ?2, ?3, ?3, ?4, ?5, ?6, ?7, 0, ?8)`,
      ).bind(
        crypto.randomUUID(),
        category.id,
        identity.viewer.userId,
        topicId,
        postId,
        category.requireTopicApproval ? "category_policy" : "lv0_first_topics",
        JSON.stringify({ title: parsed.data.title, excerpt }),
        now,
      ),
    );
  }
  await context.env.CFORUM_DB.batch(statements);

  return context.json(
    {
      topic: {
        id: topicId,
        firstPostId: postId,
        slug: `topic-${topicId.slice(0, 8)}`,
        status: topicStatus,
        reviewRequired,
      },
    },
    reviewRequired ? 202 : 201,
  );
});

router.patch("/topics/:id/pin", async (context) => {
  const identity = context.get("identity");
  if (!identity.session || !identity.viewer.userId) {
    return context.json({ error: { code: "AUTHENTICATION_REQUIRED" } }, 401);
  }
  if (
    identity.viewer.role !== "admin" ||
    identity.viewer.status !== "active"
  ) {
    return context.json({ error: { code: "ACTION_NOT_ALLOWED" } }, 403);
  }

  const topicId = context.req.param("id");
  if (!idSchema.safeParse(topicId).success) {
    return context.json({ error: { code: "NOT_FOUND" } }, 404);
  }
  const parsed = topicPinSchema.safeParse(
    await context.req.json().catch(() => null),
  );
  if (!parsed.success) {
    return context.json({ error: { code: "INVALID_INPUT" } }, 422);
  }

  const now = nowSeconds();
  const desired = parsed.data.desired;
  const mutation = desired
    ? context.env.CFORUM_DB.prepare(
        `UPDATE topics
         SET pinned_at = ?1, updated_at = ?1
         WHERE id = ?2
           AND pinned_at IS NULL
           AND status IN ('open', 'locked', 'archived')
           AND approval_status = 'approved'`,
      ).bind(now, topicId)
    : context.env.CFORUM_DB.prepare(
        `UPDATE topics
         SET pinned_at = NULL, updated_at = ?1
         WHERE id = ?2
           AND pinned_at IS NOT NULL
           AND status IN ('open', 'locked', 'archived')
           AND approval_status = 'approved'`,
      ).bind(now, topicId);

  const results = await context.env.CFORUM_DB.batch([
    mutation,
    context.env.CFORUM_DB.prepare(
      `INSERT INTO audit_logs(
         id, occurred_at, actor_user_id, actor_role, action, target_type,
         target_id, category_id, request_id, before_json, after_json
       )
       SELECT
         ?1, ?2, ?3, 'admin', ?4, 'topic',
         topic.id, topic.category_id, ?6, ?7, ?8
       FROM topics topic
       WHERE topic.id = ?5 AND changes() = 1`,
    ).bind(
      crypto.randomUUID(),
      now,
      identity.viewer.userId,
      desired ? "topic.pin" : "topic.unpin",
      topicId,
      context.get("requestId"),
      JSON.stringify({ pinned: !desired }),
      JSON.stringify({ pinned: desired }),
    ),
    context.env.CFORUM_DB.prepare(
      `SELECT id, pinned_at
       FROM topics
       WHERE id = ?1
         AND status IN ('open', 'locked', 'archived')
         AND approval_status = 'approved'
       LIMIT 1`,
    ).bind(topicId),
  ]);
  const state = results[2]?.results[0] as
    | { id: string; pinned_at: number | null }
    | undefined;
  if (!state) {
    return context.json({ error: { code: "NOT_FOUND" } }, 404);
  }

  return context.json({
    topic: { id: state.id, pinned: state.pinned_at !== null },
    changed: Number(results[0]?.meta.changes ?? 0) === 1,
  });
});

router.get("/topics/:id", async (context) => {
  const topicId = context.req.param("id");
  if (!idSchema.safeParse(topicId).success) {
    return context.json({ error: { code: "NOT_FOUND" } }, 404);
  }
  const aggregate = await getTopicAggregate(context.env.CFORUM_DB, topicId);
  if (!aggregate) return context.json({ error: { code: "NOT_FOUND" } }, 404);
  const viewer = context.get("identity").viewer;
  const decision = evaluateViewTopic(viewer, aggregate.category, aggregate.topic);
  if (!decision.allowed) {
    return context.json({ error: { code: "NOT_FOUND" } }, 404);
  }

  const replyDecision = evaluateReplyTopic(
    viewer,
    aggregate.category,
    aggregate.topic,
  );
  const [topicResult, postsResult, tagsResult] = await context.env.CFORUM_DB.batch([
    context.env.CFORUM_DB.prepare(
      `SELECT
         t.id, t.slug, t.title, t.status, t.min_view_level,
         t.effective_min_view_level, t.reply_count, t.like_count,
         t.pinned_at, t.bumped_at, t.created_at,
         c.id AS category_id, c.slug AS category_slug, c.name AS category_name,
         c.color AS category_color,
         u.id AS author_id, u.username, u.display_name, u.trust_level,
         u.avatar_upload_id
       FROM topics t
       JOIN categories c ON c.id = t.category_id
       JOIN users u ON u.id = t.author_id
       WHERE t.id = ?1`,
    ).bind(topicId),
    context.env.CFORUM_DB.prepare(
      `SELECT
         p.id, p.post_number, p.raw_markdown, p.like_count,
         p.created_at, p.updated_at,
         CASE WHEN EXISTS (
           SELECT 1 FROM reactions detail_reaction
           WHERE detail_reaction.post_id = p.id
             AND detail_reaction.user_id = ?4
             AND detail_reaction.reaction_type = 'like'
         ) THEN 1 ELSE 0 END AS liked,
         u.id AS author_id, u.username, u.display_name, u.trust_level,
         u.avatar_upload_id
       FROM posts p
       JOIN users u ON u.id = p.author_id
       WHERE p.topic_id = ?1
         AND (
           p.status = 'published'
           OR (
             p.status = 'pending'
             AND (p.author_id = ?3 OR ?2 = 1)
           )
         )
       ORDER BY p.post_number
       LIMIT 100`,
    ).bind(
      topicId,
      viewer.role === "admin" ||
        viewer.moderatedCategoryIds.has(aggregate.category.id)
        ? 1
        : 0,
      viewer.userId ?? "",
      viewer.userId ?? "",
    ),
    context.env.CFORUM_DB.prepare(
      `SELECT tags.slug, tags.name
       FROM topic_tags tt JOIN tags ON tags.id = tt.tag_id
       WHERE tt.topic_id = ?1 ORDER BY tags.name`,
    ).bind(topicId),
  ]);

  if (viewer.userId) {
    const observedPostNumber = (
      postsResult.results as Array<{ post_number: number }>
    ).reduce(
      (maximum, post) => Math.max(maximum, Number(post.post_number) || 0),
      0,
    );
    try {
      await recordTopicRead(context.env.CFORUM_DB, {
        userId: viewer.userId,
        topicId,
        maxObservedPostNumber: observedPostNumber,
        now: nowSeconds(),
      });
    } catch (error) {
      console.error("topic_read_activity_failed", {
        requestId: context.get("requestId"),
        name: error instanceof Error ? error.name : "unknown",
      });
    }
  }

  const topic = topicResult.results[0] as unknown as TopicDetailRow | undefined;
  if (!topic) return context.json({ error: { code: "NOT_FOUND" } }, 404);
  const posts = postsResult.results as unknown as PostDetailRow[];

  return context.json({
    topic: {
      id: topic.id,
      slug: topic.slug,
      title: topic.title,
      status: topic.status,
      minViewLevel: topic.min_view_level,
      effectiveMinViewLevel: topic.effective_min_view_level,
      replyCount: topic.reply_count,
      likeCount: topic.like_count,
      pinned: topic.pinned_at !== null,
      bumpedAt: isoFromSeconds(topic.bumped_at),
      createdAt: isoFromSeconds(topic.created_at),
      category: {
        id: topic.category_id,
        slug: topic.category_slug,
        name: topic.category_name,
        accent: topic.category_color,
      },
      author: {
        id: topic.author_id,
        username: topic.username,
        displayName: topic.display_name,
        trustLevel: topic.trust_level,
        avatarUrl: avatarUrl(topic.avatar_upload_id),
      },
    },
    posts: posts.map((post) => ({
      id: post.id,
      number: post.post_number,
      markdown: post.raw_markdown,
      likeCount: post.like_count,
      liked: post.liked === 1,
      createdAt: isoFromSeconds(post.created_at),
      updatedAt: isoFromSeconds(post.updated_at),
      author: {
        id: post.author_id,
        username: post.username,
        displayName: post.display_name,
        trustLevel: post.trust_level,
        avatarUrl: avatarUrl(post.avatar_upload_id),
      },
    })),
    tags: tagsResult.results,
    access: {
      readOnly: Boolean(
        decision.readOnly ||
          aggregate.topic.authorDowngradeLocked ||
          aggregate.topic.state !== "open"
      ),
      canReply: replyDecision.allowed,
      replyReason: replyDecision.reason,
      via: decision.reason,
    },
  });
});

router.post("/topics/:id/replies", async (context) => {
  const topicId = context.req.param("id");
  if (!idSchema.safeParse(topicId).success) {
    return context.json({ error: { code: "NOT_FOUND" } }, 404);
  }
  const aggregate = await getTopicAggregate(context.env.CFORUM_DB, topicId);
  if (!aggregate) return context.json({ error: { code: "NOT_FOUND" } }, 404);
  const identity = context.get("identity");
  const view = evaluateViewTopic(identity.viewer, aggregate.category, aggregate.topic);
  if (!view.allowed) return context.json({ error: { code: "NOT_FOUND" } }, 404);
  if (!identity.viewer.userId) {
    return context.json({ error: { code: "AUTHENTICATION_REQUIRED" } }, 401);
  }
  const reply = evaluateReplyTopic(identity.viewer, aggregate.category, aggregate.topic);
  if (!reply.allowed) {
    const locked = reply.reason === "topic_read_only";
    return context.json(
      { error: { code: locked ? "TOPIC_LOCKED" : "ACTION_NOT_ALLOWED" } },
      locked ? 409 : 403,
    );
  }
  const parsed = createReplySchema.safeParse(await context.req.json().catch(() => null));
  if (!parsed.success) {
    return context.json({ error: { code: "INVALID_INPUT" } }, 422);
  }

  const [reviewLimit, priorReplies, existingParticipant] = await Promise.all([
    getNumericSetting(
      context.env.CFORUM_DB,
      "lv0_first_replies_review_count",
      3,
    ),
    context.env.CFORUM_DB.prepare(
      "SELECT COUNT(*) AS count FROM posts WHERE author_id = ?1 AND post_number > 1",
    )
      .bind(identity.viewer.userId)
      .first<{ count: number }>(),
    context.env.CFORUM_DB.prepare(
      `SELECT 1 AS found FROM posts
       WHERE topic_id = ?1 AND author_id = ?2 AND post_number > 1
       LIMIT 1`,
    )
      .bind(topicId, identity.viewer.userId)
      .first<{ found: number }>(),
  ]);
  const reviewRequired =
    aggregate.category.requireReplyApproval ||
    (identity.viewer.trustLevel === 0 &&
      Number(priorReplies?.count ?? 0) < reviewLimit);
  const now = nowSeconds();
  const postId = crypto.randomUUID();
  const excerpt = plainExcerpt(parsed.data.body);
  const postStatus = reviewRequired ? "pending" : "published";
  const statements: D1PreparedStatement[] = [
    context.env.CFORUM_DB.prepare(
      `INSERT INTO posts(
         id, topic_id, author_id, post_number, raw_markdown,
         plain_text_excerpt, status, reply_to_post_id, created_at, updated_at
       )
       SELECT
         ?1, ?2, ?3, COALESCE(MAX(post_number), 0) + 1,
         ?4, ?5, ?6, ?7, ?8, ?8
       FROM posts WHERE topic_id = ?2`,
    ).bind(
      postId,
      topicId,
      identity.viewer.userId,
      parsed.data.body,
      excerpt,
      postStatus,
      parsed.data.replyToPostId ?? null,
      now,
    ),
  ];
  if (!reviewRequired) {
    statements.push(
      replyCreatedActivityStatement(context.env.CFORUM_DB, {
        userId: identity.viewer.userId,
        topicId,
        now,
      }),
    );
    statements.push(
      context.env.CFORUM_DB.prepare(
        `UPDATE topics SET
           last_post_number = (SELECT MAX(post_number) FROM posts WHERE topic_id = ?1),
           reply_count = reply_count + 1,
           unique_replier_count = unique_replier_count + ?2,
           bumped_at = ?3,
           updated_at = ?3
         WHERE id = ?1`,
      ).bind(topicId, existingParticipant ? 0 : 1, now),
    );
  } else {
    statements.push(
      context.env.CFORUM_DB.prepare(
        `INSERT INTO review_items(
           id, type, category_id, submitted_by, target_user_id,
           target_topic_id, target_post_id, trigger_reason,
           content_snapshot_json, priority, created_at
         ) VALUES (?1, 'first_post', ?2, ?3, ?3, ?4, ?5, ?6, ?7, 0, ?8)`,
      ).bind(
        crypto.randomUUID(),
        aggregate.category.id,
        identity.viewer.userId,
        topicId,
        postId,
        aggregate.category.requireReplyApproval
          ? "category_policy"
          : "lv0_first_replies",
        JSON.stringify({ excerpt }),
        now,
      ),
    );
  }
  statements.push(
    context.env.CFORUM_DB.prepare(
      `INSERT INTO audit_logs(
         id, occurred_at, actor_user_id, actor_role, action, target_type,
         target_id, category_id, request_id, after_json
       ) VALUES (?1, ?2, ?3, ?4, 'post.reply', 'post', ?5, ?6, ?7, ?8)`,
    ).bind(
      crypto.randomUUID(),
      now,
      identity.viewer.userId,
      identity.viewer.role,
      postId,
      aggregate.category.id,
      context.get("requestId"),
      JSON.stringify({ topicId, reviewRequired }),
    ),
  );
  await context.env.CFORUM_DB.batch(statements);

  return context.json(
    { post: { id: postId, status: postStatus, reviewRequired } },
    reviewRequired ? 202 : 201,
  );
});

export default router;
