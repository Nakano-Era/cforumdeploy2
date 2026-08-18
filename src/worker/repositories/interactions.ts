import type { ViewerContext } from "@/worker/permissions/policy";
import { topicVisibilityScope } from "@/worker/permissions/visibility-scope";

export interface SearchKeyset {
  rank: number;
  createdAt: number;
  postId: string;
}

export interface SearchPostRow {
  rank: number;
  post_id: string;
  post_number: number;
  excerpt: string;
  post_like_count: number;
  post_created_at: number;
  topic_id: string;
  topic_slug: string;
  topic_title: string;
  category_id: string;
  category_slug: string;
  category_name: string;
  category_color: string;
  author_id: string;
  username: string;
  display_name: string;
}

export interface InteractionTarget {
  postId: string;
  topicId: string;
}

export interface LikeMutationResult {
  changed: boolean;
  active: boolean;
  postLikeCount: number;
  topicLikeCount: number;
}

export interface BookmarkMutationResult {
  changed: boolean;
  active: boolean;
}

const searchRankExpression =
  "bm25(post_search, 0.0, 0.0, 5.0, 1.0)";

export async function searchVisiblePosts(
  database: D1Database,
  input: {
    viewer: ViewerContext;
    matchQuery: string;
    cursor: SearchKeyset | null;
    limit: number;
  },
): Promise<SearchPostRow[]> {
  const scope = topicVisibilityScope(input.viewer);
  const cursorClause = input.cursor
    ? `AND (
         ${searchRankExpression} > ?
         OR (
           ${searchRankExpression} = ?
           AND (
             p.created_at < ?
             OR (p.created_at = ? AND p.id < ?)
           )
         )
       )`
    : "";
  const bindings: Array<string | number | null> = [
    input.matchQuery,
    ...scope.bindings,
  ];
  if (input.cursor) {
    bindings.push(
      input.cursor.rank,
      input.cursor.rank,
      input.cursor.createdAt,
      input.cursor.createdAt,
      input.cursor.postId,
    );
  }
  bindings.push(input.limit);

  const result = await database
    .prepare(
      `SELECT
         ${searchRankExpression} AS rank,
         p.id AS post_id,
         p.post_number,
         p.plain_text_excerpt AS excerpt,
         p.like_count AS post_like_count,
         p.created_at AS post_created_at,
         t.id AS topic_id,
         t.slug AS topic_slug,
         t.title AS topic_title,
         c.id AS category_id,
         c.slug AS category_slug,
         c.name AS category_name,
         c.color AS category_color,
         author.id AS author_id,
         author.username,
         author.display_name
       FROM post_search
       JOIN posts p
         ON p.id = post_search.post_id
        AND p.topic_id = post_search.topic_id
       JOIN topics t ON t.id = p.topic_id
       JOIN categories c ON c.id = t.category_id
       JOIN users author ON author.id = p.author_id
       WHERE post_search MATCH ?
         AND p.status = 'published'
         AND ${scope.clause}
         ${cursorClause}
       ORDER BY rank ASC, p.created_at DESC, p.id DESC
       LIMIT ?`,
    )
    .bind(...bindings)
    .all<SearchPostRow>();
  return result.results;
}

export async function getPublishedInteractionTarget(
  database: D1Database,
  postId: string,
): Promise<InteractionTarget | null> {
  const row = await database
    .prepare(
      `SELECT p.id AS post_id, p.topic_id
       FROM posts p
       JOIN topics t ON t.id = p.topic_id
       JOIN categories c ON c.id = t.category_id
       WHERE p.id = ?1
         AND p.status = 'published'
         AND t.status IN ('open', 'locked', 'archived')
         AND t.approval_status = 'approved'
         AND c.state != 'deleted'
       LIMIT 1`,
    )
    .bind(postId)
    .first<{ post_id: string; topic_id: string }>();
  return row ? { postId: row.post_id, topicId: row.topic_id } : null;
}

function activeTargetGuard(): string {
  return `EXISTS (
           SELECT 1
           FROM posts guarded_post
           JOIN topics guarded_topic ON guarded_topic.id = guarded_post.topic_id
           JOIN categories guarded_category
             ON guarded_category.id = guarded_topic.category_id
           WHERE guarded_post.id = ?1
             AND guarded_post.topic_id = ?3
             AND guarded_post.status = 'published'
             AND guarded_topic.status IN ('open', 'locked', 'archived')
             AND guarded_topic.approval_status = 'approved'
             AND guarded_category.state != 'deleted'
         )`;
}

export async function setLikeReaction(
  database: D1Database,
  input: {
    postId: string;
    topicId: string;
    userId: string;
    desired: boolean;
    now: number;
  },
): Promise<LikeMutationResult> {
  const mutation = input.desired
    ? database
        .prepare(
          `INSERT INTO reactions(post_id, user_id, reaction_type, created_at)
           SELECT ?1, ?2, 'like', ?4
           WHERE EXISTS (
             SELECT 1 FROM users WHERE id = ?2 AND status = 'active'
           )
             AND ${activeTargetGuard()}
           ON CONFLICT(post_id, user_id, reaction_type) DO NOTHING`,
        )
        .bind(input.postId, input.userId, input.topicId, input.now)
    : database
        .prepare(
          `DELETE FROM reactions
           WHERE post_id = ?1
             AND user_id = ?2
             AND reaction_type = 'like'
             AND EXISTS (
               SELECT 1 FROM users WHERE id = ?2 AND status = 'active'
             )
             AND ${activeTargetGuard()}`,
        )
        .bind(input.postId, input.userId, input.topicId);
  const results = await database.batch([
    mutation,
    database
      .prepare(
        `UPDATE posts
         SET like_count = (
           SELECT COUNT(*)
           FROM reactions
           WHERE post_id = ?1 AND reaction_type = 'like'
         )
         WHERE id = ?1`,
      )
      .bind(input.postId),
    database
      .prepare(
        `UPDATE topics
         SET like_count = (
           SELECT COUNT(*)
           FROM reactions counted_reaction
           JOIN posts counted_post
             ON counted_post.id = counted_reaction.post_id
           WHERE counted_post.topic_id = ?1
             AND counted_reaction.reaction_type = 'like'
         )
         WHERE id = ?1`,
      )
      .bind(input.topicId),
    database
      .prepare(
        `SELECT
           p.like_count AS post_like_count,
           t.like_count AS topic_like_count,
           EXISTS (
             SELECT 1 FROM reactions r
             WHERE r.post_id = p.id
               AND r.user_id = ?3
               AND r.reaction_type = 'like'
           ) AS active
         FROM posts p
         JOIN topics t ON t.id = p.topic_id
         WHERE p.id = ?1 AND t.id = ?2
         LIMIT 1`,
      )
      .bind(input.postId, input.topicId, input.userId),
  ]);
  const state = results[3]?.results[0] as
    | {
        post_like_count: number;
        topic_like_count: number;
        active: number;
      }
    | undefined;
  if (!state) throw new Error("interaction_target_disappeared");

  return {
    changed: Number(results[0]?.meta.changes ?? 0) === 1,
    active: state.active === 1,
    postLikeCount: state.post_like_count,
    topicLikeCount: state.topic_like_count,
  };
}

export async function setPostBookmark(
  database: D1Database,
  input: {
    postId: string;
    topicId: string;
    userId: string;
    desired: boolean;
    now: number;
  },
): Promise<BookmarkMutationResult> {
  const mutation = input.desired
    ? database
        .prepare(
          `INSERT INTO bookmarks(
             id, user_id, topic_id, post_id, created_at
           )
           SELECT ?4, ?2, ?3, ?1, ?5
           WHERE EXISTS (
             SELECT 1 FROM users WHERE id = ?2 AND status = 'active'
           )
             AND ${activeTargetGuard()}
             AND NOT EXISTS (
               SELECT 1
               FROM bookmarks existing
               WHERE existing.user_id = ?2
                 AND existing.topic_id = ?3
                 AND COALESCE(existing.post_id, '') = ?1
             )
           ON CONFLICT DO NOTHING`,
        )
        .bind(
          input.postId,
          input.userId,
          input.topicId,
          crypto.randomUUID(),
          input.now,
        )
    : database
        .prepare(
          `DELETE FROM bookmarks
           WHERE user_id = ?2
             AND topic_id = ?3
             AND COALESCE(post_id, '') = ?1
             AND EXISTS (
               SELECT 1 FROM users WHERE id = ?2 AND status = 'active'
             )
             AND ${activeTargetGuard()}`,
        )
        .bind(input.postId, input.userId, input.topicId);
  const results = await database.batch([
    mutation,
    database
      .prepare(
        `SELECT EXISTS (
           SELECT 1
           FROM bookmarks
           WHERE user_id = ?2
             AND topic_id = ?3
             AND COALESCE(post_id, '') = ?1
         ) AS active`,
      )
      .bind(input.postId, input.userId, input.topicId),
  ]);
  const state = results[1]?.results[0] as { active: number } | undefined;
  if (!state) throw new Error("bookmark_state_unavailable");
  return {
    changed: Number(results[0]?.meta.changes ?? 0) === 1,
    active: state.active === 1,
  };
}
