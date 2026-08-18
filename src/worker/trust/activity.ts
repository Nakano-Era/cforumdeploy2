const MAX_DAILY_READING_SECONDS = 4 * 60 * 60;
const HEARTBEAT_MAX_GAP_SECONDS = 5 * 60;

export function utcActivityDate(now: number): string {
  return new Date(now * 1_000).toISOString().slice(0, 10);
}

export function utcDayStart(now: number): number {
  const date = new Date(now * 1_000);
  return Math.floor(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) /
      1_000,
  );
}

/** Must immediately follow the successful first-post INSERT in a D1 batch. */
export function topicCreatedActivityStatement(
  database: D1Database,
  input: { userId: string; now: number; published: boolean },
): D1PreparedStatement {
  return database
    .prepare(
      `INSERT INTO user_activity_daily(user_id, activity_date, active)
       SELECT ?1, ?2, 1 WHERE changes() = 1 AND ?3 = 1
       ON CONFLICT(user_id, activity_date) DO UPDATE SET active = 1`,
    )
    .bind(input.userId, utcActivityDate(input.now), input.published ? 1 : 0);
}

/** Must immediately follow the successful published reply INSERT in a D1 batch. */
export function replyCreatedActivityStatement(
  database: D1Database,
  input: { userId: string; topicId: string; now: number },
): D1PreparedStatement {
  const dayStart = utcDayStart(input.now);
  return database
    .prepare(
      `INSERT INTO user_activity_daily(
         user_id, activity_date, replies_created, distinct_topics_replied, active
       )
       SELECT
         ?1,
         ?2,
         1,
         CASE WHEN (
           SELECT COUNT(*) FROM posts
           WHERE author_id = ?1
             AND topic_id = ?3
             AND post_number > 1
             AND status = 'published'
             AND created_at >= ?4
             AND created_at < ?5
         ) = 1 THEN 1 ELSE 0 END,
         1
       WHERE changes() = 1
       ON CONFLICT(user_id, activity_date) DO UPDATE SET
         replies_created = replies_created + excluded.replies_created,
         distinct_topics_replied =
           distinct_topics_replied + excluded.distinct_topics_replied,
         active = 1`,
    )
    .bind(
      input.userId,
      utcActivityDate(input.now),
      input.topicId,
      dayStart,
      dayStart + 24 * 60 * 60,
    );
}

/**
 * Records only server-observable reading progress: one topic entry per UTC day
 * and published posts beyond the prior monotonic read position. Replaying the
 * same request produces no activity increment.
 */
export async function recordTopicRead(
  database: D1Database,
  input: {
    userId: string;
    topicId: string;
    maxObservedPostNumber: number;
    now: number;
  },
): Promise<{ changed: boolean }> {
  if (input.maxObservedPostNumber < 1) return { changed: false };
  const activityDate = utcActivityDate(input.now);
  const dayStart = utcDayStart(input.now);
  const results = await database.batch([
    database
      .prepare(
        `INSERT INTO user_activity_daily(
           user_id, activity_date, topics_entered, posts_read, active
         )
         SELECT
           ?1,
           ?4,
           CASE WHEN COALESCE(
             (SELECT last_read_at FROM topic_reads
              WHERE user_id = ?1 AND topic_id = ?2),
             0
           ) < ?5 THEN 1 ELSE 0 END,
           (
             SELECT COUNT(*) FROM posts
             WHERE topic_id = ?2
               AND status = 'published'
               AND post_number > COALESCE(
                 (SELECT last_read_post_number FROM topic_reads
                  WHERE user_id = ?1 AND topic_id = ?2),
                 0
               )
               AND post_number <= ?3
           ),
           1
         WHERE EXISTS (
           SELECT 1 FROM users
           WHERE id = ?1 AND status IN ('active', 'silenced')
         )
           AND EXISTS (
             SELECT 1 FROM posts
             WHERE topic_id = ?2
               AND status = 'published'
               AND post_number <= ?3
           )
           AND (
             COALESCE(
               (SELECT last_read_at FROM topic_reads
                WHERE user_id = ?1 AND topic_id = ?2),
               0
             ) < ?5
             OR EXISTS (
               SELECT 1 FROM posts
               WHERE topic_id = ?2
                 AND status = 'published'
                 AND post_number > COALESCE(
                   (SELECT last_read_post_number FROM topic_reads
                    WHERE user_id = ?1 AND topic_id = ?2),
                   0
                 )
                 AND post_number <= ?3
             )
           )
         ON CONFLICT(user_id, activity_date) DO UPDATE SET
           topics_entered = topics_entered + excluded.topics_entered,
           posts_read = posts_read + excluded.posts_read,
           active = 1`,
      )
      .bind(
        input.userId,
        input.topicId,
        input.maxObservedPostNumber,
        activityDate,
        dayStart,
      ),
    database
      .prepare(
        `INSERT INTO topic_reads(
           user_id, topic_id, last_read_post_number, first_read_at, last_read_at
         )
         SELECT
           ?1,
           ?2,
           MAX(post_number),
           ?4,
           ?4
         FROM posts
         WHERE topic_id = ?2
           AND status = 'published'
           AND post_number <= ?3
         HAVING MAX(post_number) IS NOT NULL
         ON CONFLICT(user_id, topic_id) DO UPDATE SET
           last_read_post_number = MAX(
             topic_reads.last_read_post_number,
             excluded.last_read_post_number
           ),
           last_read_at = MAX(topic_reads.last_read_at, excluded.last_read_at)
         WHERE excluded.last_read_post_number > topic_reads.last_read_post_number
            OR topic_reads.last_read_at < ?5`,
      )
      .bind(
        input.userId,
        input.topicId,
        input.maxObservedPostNumber,
        input.now,
        dayStart,
      ),
  ]);
  return {
    changed:
      Number(results[0]?.meta.changes ?? 0) === 1 ||
      Number(results[1]?.meta.changes ?? 0) === 1,
  };
}

/**
 * Credits real elapsed time only after a recent topic read. The monotonic
 * `last_read_at` update is the replay/concurrency guard. This cannot prove
 * human attention, so each claim is capped by the route and the daily total is
 * capped here.
 */
export async function recordReadingHeartbeat(
  database: D1Database,
  input: {
    userId: string;
    topicId: string;
    rateKeyHash: string;
    seconds: number;
    now: number;
  },
): Promise<{ accepted: boolean; readingSecondsToday: number }> {
  const activityDate = utcActivityDate(input.now);
  const periodStart = Math.floor(input.now / 60) * 60;
  const results = await database.batch([
    database
      .prepare(
        `INSERT INTO rate_limit_buckets(
           key_hash, action, period_start, count, expires_at
         ) VALUES (?1, 'reading_heartbeat', ?2, 1, ?3)
         ON CONFLICT(key_hash, action, period_start) DO UPDATE SET
           count = rate_limit_buckets.count + 1
         WHERE rate_limit_buckets.count < 1`,
      )
      .bind(input.rateKeyHash, periodStart, input.now + 10 * 60),
    database
      .prepare(
        `UPDATE topic_reads
         SET last_read_at = ?4
         WHERE user_id = ?1
           AND topic_id = ?2
           AND changes() = 1
           AND last_read_at <= ?4 - ?3
           AND last_read_at >= ?4 - ?5
           AND EXISTS (
             SELECT 1 FROM users
             WHERE id = ?1 AND status = 'active'
           )`,
      )
      .bind(
        input.userId,
        input.topicId,
        input.seconds,
        input.now,
        HEARTBEAT_MAX_GAP_SECONDS,
      ),
    database
      .prepare(
        `INSERT INTO user_activity_daily(
           user_id, activity_date, reading_seconds, active
         )
         SELECT ?1, ?2, MIN(?3, ?4), 1
         WHERE changes() = 1
         ON CONFLICT(user_id, activity_date) DO UPDATE SET
           reading_seconds = MIN(
             ?4,
             user_activity_daily.reading_seconds + excluded.reading_seconds
           ),
           active = 1
         WHERE user_activity_daily.reading_seconds < ?4`,
      )
      .bind(
        input.userId,
        activityDate,
        input.seconds,
        MAX_DAILY_READING_SECONDS,
      ),
    database
      .prepare(
        `SELECT reading_seconds
         FROM user_activity_daily
         WHERE user_id = ?1 AND activity_date = ?2`,
      )
      .bind(input.userId, activityDate),
  ]);
  const row = results[3]?.results[0] as
    | { reading_seconds: number }
    | undefined;
  return {
    accepted: Number(results[2]?.meta.changes ?? 0) === 1,
    readingSecondsToday: Number(row?.reading_seconds ?? 0),
  };
}

export { MAX_DAILY_READING_SECONDS };
