import type { TrustLevel, UserRole, UserStatus } from "@/shared/domain";
import type { Bindings } from "@/worker/env";
import type { ViewerContext } from "@/worker/permissions/policy";
import { topicVisibilityScope } from "@/worker/permissions/visibility-scope";
import { nowSeconds } from "@/worker/security/crypto";
import {
  parseTrustRule,
  type LevelOneRule,
  type LevelThreeRule,
  type LevelTwoRule,
  type TrustRules,
} from "@/worker/trust/schemas";
import { utcActivityDate } from "@/worker/trust/activity";

const DAY_SECONDS = 24 * 60 * 60;
const DEFAULT_BATCH_SIZE = 25;
const MAX_BATCH_SIZE = 100;
const PROMOTION_REVIEW_INTERVAL_SECONDS = DAY_SECONDS;
const LEVEL_THREE_REVIEW_INTERVAL_SECONDS = DAY_SECONDS;
const POST_TRANSITION_REVIEW_SECONDS = 15 * 60;
const FAILED_REVIEW_BACKOFF_SECONDS = 60 * 60;

export const CONFIRMED_REPORT_TIME_SQL =
  "COALESCE(reports.resolved_at, reports.created_at)";

const LEVEL_NOTIFICATION_KINDS = [
  "trust_level_promoted",
  "trust_level_demotion_warning",
  "trust_level_demoted",
] as const;

type LevelNotificationKind = (typeof LEVEL_NOTIFICATION_KINDS)[number];

interface CandidateRow {
  id: string;
  trust_level: number;
  role: UserRole;
  status: UserStatus;
  level_locked: number;
  next_level_review_at: number | null;
  created_at: number;
  updated_at: number;
  group_ids_json: string;
  moderated_category_ids_json: string;
}

interface TrustRuleRow {
  level: number;
  rule_json: string;
  updated_at: number;
}

export interface TrustMetrics {
  asOfDate: string;
  windowStartDate: string;
  lifetime: {
    topicsEntered: number;
    postsRead: number;
    readingSeconds: number;
    visitDays: number;
    distinctTopicsReplied: number;
    likesGiven: number;
    likesReceived: number;
  };
  window: {
    windowDays: number;
    topicsEntered: number;
    postsRead: number;
    readingSeconds: number;
    readingDays: number;
    distinctTopicsReplied: number;
    likesGiven: number;
    likesReceived: number;
    likeGiverCount: number;
    likeDayCount: number;
    newTopics: number;
    newPosts: number;
    confirmedSevereReports: number;
    recentSanctions: number;
  };
  lastQualifyingActivityAt: number;
  firstPromotedToLevelThreeAt: number | null;
}

export interface TrustReviewDecision {
  targetLevel: TrustLevel | null;
  reason: string | null;
  nextReviewAt: number | null;
  warning: {
    fromLevel: 2;
    toLevel: 1;
    deadlineAt: number;
  } | null;
}

export interface TrustReviewCursor {
  dueAt: number;
  userId: string;
}

export interface TrustReviewSummary {
  selected: number;
  processed: number;
  transitioned: number;
  warningsCreated: number;
  failed: number;
  emailsQueued: number;
  nextCursor: TrustReviewCursor | null;
}

function asNumber(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function asTrustLevel(value: number): TrustLevel {
  if (!Number.isInteger(value) || value < 0 || value > 4) {
    throw new Error("invalid_user_trust_level");
  }
  return value as TrustLevel;
}

function daysBeforeDate(asOfSeconds: number, days: number): string {
  return utcActivityDate(asOfSeconds - (days - 1) * DAY_SECONDS);
}

function requiredByPercent(total: number, percent: number, cap: number): number {
  return Math.min(cap, Math.ceil((total * percent) / 100));
}

function parseIdSet(json: string): Set<string> {
  try {
    const value = JSON.parse(json) as unknown;
    if (!Array.isArray(value)) return new Set();
    return new Set(
      value.filter((item): item is string => typeof item === "string"),
    );
  } catch {
    return new Set();
  }
}

export function trustMetricViewer(
  user: Pick<
    CandidateRow,
    | "id"
    | "role"
    | "status"
    | "trust_level"
    | "group_ids_json"
    | "moderated_category_ids_json"
  >,
): ViewerContext {
  return {
    userId: user.id,
    role: user.role,
    status: user.status,
    trustLevel: asTrustLevel(user.trust_level),
    groupIds: parseIdSet(user.group_ids_json),
    moderatedCategoryIds: parseIdSet(user.moderated_category_ids_json),
  };
}

export function trustMetricDenominatorScope(
  user: Parameters<typeof trustMetricViewer>[0],
) {
  return topicVisibilityScope(trustMetricViewer(user));
}

interface VisibleDenominators {
  newTopics: number;
  newPosts: number;
}

function denominatorCacheKey(user: CandidateRow): string {
  const viewer = trustMetricViewer(user);
  return JSON.stringify({
    role: viewer.role,
    status: viewer.status,
    trustLevel: viewer.trustLevel,
    groups: [...viewer.groupIds].sort(),
    moderatedCategories: [...viewer.moderatedCategoryIds].sort(),
  });
}

async function loadVisibleDenominators(
  database: D1Database,
  user: CandidateRow,
  windowStartSeconds: number,
  cache: Map<string, Promise<VisibleDenominators>>,
): Promise<VisibleDenominators> {
  const key = denominatorCacheKey(user);
  const existing = cache.get(key);
  if (existing) return existing;

  const pending = (async () => {
    const visibility = trustMetricDenominatorScope(user);
    const row = await database
      .prepare(
        `SELECT
           (SELECT COUNT(*)
            FROM topics t
            JOIN categories c ON c.id = t.category_id
            WHERE t.created_at >= ?
              AND ${visibility.clause}) AS new_topics,
           (SELECT COUNT(*)
            FROM posts p
            JOIN topics t ON t.id = p.topic_id
            JOIN categories c ON c.id = t.category_id
            WHERE p.created_at >= ?
              AND p.status = 'published'
              AND ${visibility.clause}) AS new_posts`,
      )
      .bind(
        windowStartSeconds,
        ...visibility.bindings,
        windowStartSeconds,
        ...visibility.bindings,
      )
      .first<{ new_topics: number; new_posts: number }>();
    return {
      newTopics: asNumber(row?.new_topics),
      newPosts: asNumber(row?.new_posts),
    };
  })();
  cache.set(key, pending);
  try {
    return await pending;
  } catch (error) {
    cache.delete(key);
    throw error;
  }
}

export function meetsLevelOne(
  metrics: TrustMetrics,
  rule: LevelOneRule,
): boolean {
  return (
    metrics.lifetime.topicsEntered >= rule.topicsEntered &&
    metrics.lifetime.postsRead >= rule.postsRead &&
    metrics.lifetime.readingSeconds >= rule.readingSeconds
  );
}

export function meetsLevelTwo(
  metrics: TrustMetrics,
  rule: LevelTwoRule,
): boolean {
  return (
    metrics.lifetime.topicsEntered >= rule.topicsEntered &&
    metrics.lifetime.postsRead >= rule.postsRead &&
    metrics.lifetime.readingSeconds >= rule.readingSeconds &&
    metrics.lifetime.visitDays >= rule.visitDays &&
    metrics.lifetime.distinctTopicsReplied >= rule.distinctTopicsReplied &&
    metrics.lifetime.likesGiven >= rule.likesGiven &&
    metrics.lifetime.likesReceived >= rule.likesReceived
  );
}

function levelThreeThresholds(metrics: TrustMetrics, rule: LevelThreeRule) {
  return {
    topicsEntered: requiredByPercent(
      metrics.window.newTopics,
      rule.topicPercent,
      rule.topicCap,
    ),
    postsRead: requiredByPercent(
      metrics.window.newPosts,
      rule.postPercent,
      rule.postCap,
    ),
    distinctTopicsReplied: rule.distinctTopicsReplied,
    readingDays: rule.readingDays,
    likesGiven: rule.likesGiven,
    likesReceived: rule.likesReceived,
    likeGiverCount: rule.likeGiverCount,
    likeDayCount: rule.likeDayCount,
  };
}

function meetsRatio(actual: number, required: number, ratio: number): boolean {
  return required === 0 || actual / required >= ratio;
}

export function meetsLevelThree(
  metrics: TrustMetrics,
  rule: LevelThreeRule,
  ratio = 1,
): boolean {
  const required = levelThreeThresholds(metrics, rule);
  return (
    meetsRatio(metrics.window.topicsEntered, required.topicsEntered, ratio) &&
    meetsRatio(metrics.window.postsRead, required.postsRead, ratio) &&
    meetsRatio(
      metrics.window.distinctTopicsReplied,
      required.distinctTopicsReplied,
      ratio,
    ) &&
    meetsRatio(metrics.window.readingDays, required.readingDays, ratio) &&
    meetsRatio(metrics.window.likesGiven, required.likesGiven, ratio) &&
    meetsRatio(metrics.window.likesReceived, required.likesReceived, ratio) &&
    meetsRatio(
      metrics.window.likeGiverCount,
      required.likeGiverCount,
      ratio,
    ) &&
    meetsRatio(metrics.window.likeDayCount, required.likeDayCount, ratio) &&
    metrics.window.confirmedSevereReports <=
      rule.maxConfirmedSevereReports &&
    metrics.window.recentSanctions === 0
  );
}

export function evaluateTrustLevel(
  user: Pick<
    CandidateRow,
    "trust_level" | "status" | "level_locked" | "created_at"
  >,
  rules: TrustRules,
  metrics: TrustMetrics,
  now: number,
): TrustReviewDecision {
  const currentLevel = asTrustLevel(user.trust_level);
  if (user.level_locked === 1 || currentLevel === 4) {
    return {
      targetLevel: null,
      reason: null,
      nextReviewAt: null,
      warning: null,
    };
  }
  if (user.status !== "active" && user.status !== "silenced") {
    return {
      targetLevel: null,
      reason: null,
      nextReviewAt: null,
      warning: null,
    };
  }

  const active = user.status === "active";
  const ordinaryNextReview = now + PROMOTION_REVIEW_INTERVAL_SECONDS;
  if (currentLevel === 0) {
    return active && meetsLevelOne(metrics, rules[1])
      ? {
          targetLevel: 1,
          reason: "automatic_level_one_criteria_met",
          nextReviewAt: now + POST_TRANSITION_REVIEW_SECONDS,
          warning: null,
        }
      : {
          targetLevel: null,
          reason: null,
          nextReviewAt: ordinaryNextReview,
          warning: null,
        };
  }

  if (currentLevel === 1) {
    const freshEnoughForLevelTwo =
      Math.max(user.created_at, metrics.lastQualifyingActivityAt) +
        rules[2].demoteAfterInactiveDays * DAY_SECONDS >
      now;
    return active && meetsLevelTwo(metrics, rules[2]) && freshEnoughForLevelTwo
      ? {
          targetLevel: 2,
          reason: "automatic_level_two_criteria_met",
          nextReviewAt: now + POST_TRANSITION_REVIEW_SECONDS,
          warning: null,
        }
      : {
          targetLevel: null,
          reason: null,
          nextReviewAt: ordinaryNextReview,
          warning: null,
        };
  }

  if (currentLevel === 2) {
    const lastActivity = Math.max(
      user.created_at,
      metrics.lastQualifyingActivityAt,
    );
    const demotionAt =
      lastActivity + rules[2].demoteAfterInactiveDays * DAY_SECONDS;
    if (now >= demotionAt) {
      return {
        targetLevel: 1,
        reason: "automatic_level_two_inactivity",
        nextReviewAt: now + POST_TRANSITION_REVIEW_SECONDS,
        warning: null,
      };
    }
    if (active && meetsLevelThree(metrics, rules[3])) {
      return {
        targetLevel: 3,
        reason: "automatic_level_three_criteria_met",
        nextReviewAt: now + POST_TRANSITION_REVIEW_SECONDS,
        warning: null,
      };
    }
    const warningAt = demotionAt - rules[2].warningDays * DAY_SECONDS;
    const warning =
      rules[2].warningDays > 0 && now >= warningAt
        ? { fromLevel: 2 as const, toLevel: 1 as const, deadlineAt: demotionAt }
        : null;
    return {
      targetLevel: null,
      reason: null,
      nextReviewAt: Math.min(ordinaryNextReview, demotionAt),
      warning,
    };
  }

  const firstPromotion = metrics.firstPromotedToLevelThreeAt;
  const graceEndsAt = firstPromotion
    ? firstPromotion + rules[3].graceDays * DAY_SECONDS
    : 0;
  const stillQualified =
    active && meetsLevelThree(metrics, rules[3], rules[3].demotionRatio);
  if (!stillQualified && now >= graceEndsAt) {
    return {
      targetLevel: 2,
      reason: "automatic_level_three_criteria_lost",
      nextReviewAt: now + POST_TRANSITION_REVIEW_SECONDS,
      warning: null,
    };
  }
  return {
    targetLevel: null,
    reason: null,
    nextReviewAt:
      !stillQualified && graceEndsAt > now
        ? graceEndsAt
        : now + LEVEL_THREE_REVIEW_INTERVAL_SECONDS,
    warning: null,
  };
}

async function loadTrustRules(
  database: D1Database,
): Promise<{ rules: TrustRules; updatedAt: Record<1 | 2 | 3 | 4, number> }> {
  const result = await database
    .prepare(
      `SELECT level, rule_json, updated_at
       FROM trust_level_rules
       ORDER BY level`,
    )
    .all<TrustRuleRow>();
  if (result.results.length !== 4) throw new Error("trust_rules_incomplete");

  const parsed = new Map<number, unknown>();
  const updatedAt = new Map<number, number>();
  for (const row of result.results) {
    if (![1, 2, 3, 4].includes(row.level) || parsed.has(row.level)) {
      throw new Error("trust_rules_invalid");
    }
    let json: unknown;
    try {
      json = JSON.parse(row.rule_json) as unknown;
    } catch {
      throw new Error("trust_rules_invalid");
    }
    parsed.set(row.level, parseTrustRule(row.level as 1 | 2 | 3 | 4, json));
    updatedAt.set(row.level, row.updated_at);
  }

  return {
    rules: {
      1: parsed.get(1) as TrustRules[1],
      2: parsed.get(2) as TrustRules[2],
      3: parsed.get(3) as TrustRules[3],
      4: parsed.get(4) as TrustRules[4],
    },
    updatedAt: {
      1: updatedAt.get(1) ?? 0,
      2: updatedAt.get(2) ?? 0,
      3: updatedAt.get(3) ?? 0,
      4: updatedAt.get(4) ?? 0,
    },
  };
}

async function loadTrustMetrics(
  database: D1Database,
  user: CandidateRow,
  rule: LevelThreeRule,
  now: number,
  denominatorCache: Map<string, Promise<VisibleDenominators>>,
): Promise<TrustMetrics> {
  const asOfDate = utcActivityDate(now);
  const windowStartDate = daysBeforeDate(now, rule.windowDays);
  const windowStartSeconds = Math.floor(
    Date.parse(`${windowStartDate}T00:00:00.000Z`) / 1_000,
  );
  const sanctionStartSeconds = now - rule.sanctionFreeDays * DAY_SECONDS;
  const denominators = await loadVisibleDenominators(
    database,
    user,
    windowStartSeconds,
    denominatorCache,
  );
  const [dailyResult, contentResult, likeResult, qualityResult] =
    await database.batch([
      database
        .prepare(
          `SELECT
             COALESCE(SUM(topics_entered), 0) AS lifetime_topics_entered,
             COALESCE(SUM(posts_read), 0) AS lifetime_posts_read,
             COALESCE(SUM(reading_seconds), 0) AS lifetime_reading_seconds,
             COALESCE(SUM(active), 0) AS lifetime_visit_days,
             COALESCE(SUM(CASE WHEN activity_date >= ?2 THEN topics_entered ELSE 0 END), 0)
               AS window_topics_entered,
             COALESCE(SUM(CASE WHEN activity_date >= ?2 THEN posts_read ELSE 0 END), 0)
               AS window_posts_read,
             COALESCE(SUM(CASE WHEN activity_date >= ?2 THEN reading_seconds ELSE 0 END), 0)
               AS window_reading_seconds,
             COALESCE(SUM(CASE
               WHEN activity_date >= ?2 AND (posts_read > 0 OR reading_seconds > 0)
               THEN 1 ELSE 0 END), 0) AS window_reading_days,
             MAX(CASE
               WHEN posts_read > 0 OR replies_created > 0
               THEN activity_date ELSE NULL END) AS last_qualifying_date
           FROM user_activity_daily
           WHERE user_id = ?1`,
        )
        .bind(user.id, windowStartDate),
      database
        .prepare(
          `SELECT
             COUNT(DISTINCT CASE
               WHEN p.post_number > 1 AND p.status = 'published'
               THEN p.topic_id END) AS lifetime_distinct_topics_replied,
             COUNT(DISTINCT CASE
               WHEN p.post_number > 1
                 AND p.status = 'published'
                 AND p.created_at >= ?2
               THEN p.topic_id END) AS window_distinct_topics_replied,
             MAX(CASE WHEN p.status = 'published' THEN p.created_at END)
               AS last_post_at,
             (SELECT MAX(t.created_at) FROM topics t
              WHERE t.author_id = ?1
                AND t.approval_status = 'approved'
                AND t.status != 'deleted') AS last_topic_at,
             (SELECT MAX(tr.last_read_at) FROM topic_reads tr
              WHERE tr.user_id = ?1 AND tr.last_read_post_number > 0)
               AS last_read_at
           FROM posts p
           WHERE p.author_id = ?1`,
        )
        .bind(user.id, windowStartSeconds),
      database
        .prepare(
          `SELECT
             (SELECT COUNT(*)
              FROM reactions r
              JOIN posts p ON p.id = r.post_id
              JOIN topics t ON t.id = p.topic_id
              WHERE r.user_id = ?1
                AND r.reaction_type = 'like'
                AND p.author_id != ?1
                AND p.status = 'published'
                AND t.approval_status = 'approved'
                AND t.status != 'deleted') AS lifetime_likes_given,
             (SELECT COUNT(*)
              FROM posts p
              JOIN topics t ON t.id = p.topic_id
              JOIN reactions r ON r.post_id = p.id
              WHERE p.author_id = ?1
                AND r.user_id != ?1
                AND r.reaction_type = 'like'
                AND p.status = 'published'
                AND t.approval_status = 'approved'
                AND t.status != 'deleted') AS lifetime_likes_received,
             (SELECT COUNT(*)
              FROM reactions r
              JOIN posts p ON p.id = r.post_id
              JOIN topics t ON t.id = p.topic_id
              WHERE r.user_id = ?1
                AND r.reaction_type = 'like'
                AND r.created_at >= ?2
                AND p.author_id != ?1
                AND p.status = 'published'
                AND t.approval_status = 'approved'
                AND t.status != 'deleted') AS window_likes_given,
             (SELECT COUNT(*)
              FROM posts p
              JOIN topics t ON t.id = p.topic_id
              JOIN reactions r ON r.post_id = p.id
              WHERE p.author_id = ?1
                AND r.user_id != ?1
                AND r.reaction_type = 'like'
                AND r.created_at >= ?2
                AND p.status = 'published'
                AND t.approval_status = 'approved'
                AND t.status != 'deleted') AS window_likes_received,
             (SELECT COUNT(DISTINCT r.user_id)
              FROM posts p
              JOIN topics t ON t.id = p.topic_id
              JOIN reactions r ON r.post_id = p.id
              WHERE p.author_id = ?1
                AND r.user_id != ?1
                AND r.reaction_type = 'like'
                AND r.created_at >= ?2
                AND p.status = 'published'
                AND t.approval_status = 'approved'
                AND t.status != 'deleted') AS window_like_givers,
             (SELECT COUNT(DISTINCT date(r.created_at, 'unixepoch'))
              FROM posts p
              JOIN topics t ON t.id = p.topic_id
              JOIN reactions r ON r.post_id = p.id
              WHERE p.author_id = ?1
                AND r.user_id != ?1
                AND r.reaction_type = 'like'
                AND r.created_at >= ?2
                AND p.status = 'published'
                AND t.approval_status = 'approved'
                AND t.status != 'deleted') AS window_like_days`,
        )
        .bind(user.id, windowStartSeconds),
      database
        .prepare(
          `SELECT
             (SELECT COUNT(DISTINCT reports.target_post_id)
              FROM reports
              JOIN posts ON posts.id = reports.target_post_id
              WHERE posts.author_id = ?
                AND reports.status = 'accepted'
                AND reports.report_type IN ('inappropriate', 'spam', 'illegal')
                AND ${CONFIRMED_REPORT_TIME_SQL} >= ?)
               AS confirmed_severe_reports,
             (SELECT COUNT(*) FROM moderation_actions
              WHERE target_user_id = ?
                AND created_at >= ?
                AND action IN (
                  'silence', 'suspend', 'user.silence', 'user.suspend',
                  'silenced', 'suspended'
                )) AS recent_sanctions,
             (SELECT MIN(created_at) FROM user_level_history
              WHERE user_id = ? AND to_level = 3)
               AS first_promoted_to_level_three_at`,
        )
        .bind(
          user.id,
          windowStartSeconds,
          user.id,
          sanctionStartSeconds,
          user.id,
        ),
    ]);

  const daily = (dailyResult.results[0] ?? {}) as Record<string, unknown>;
  const content = (contentResult.results[0] ?? {}) as Record<string, unknown>;
  const likes = (likeResult.results[0] ?? {}) as Record<string, unknown>;
  const quality = (qualityResult.results[0] ?? {}) as Record<string, unknown>;
  const lastDailyDate = daily.last_qualifying_date;
  const parsedLastDailyAt =
    typeof lastDailyDate === "string"
      ? Math.floor(Date.parse(`${lastDailyDate}T23:59:59.000Z`) / 1_000)
      : 0;
  const lastDailyAt = Number.isFinite(parsedLastDailyAt)
    ? parsedLastDailyAt
    : 0;

  return {
    asOfDate,
    windowStartDate,
    lifetime: {
      topicsEntered: asNumber(daily.lifetime_topics_entered),
      postsRead: asNumber(daily.lifetime_posts_read),
      readingSeconds: asNumber(daily.lifetime_reading_seconds),
      visitDays: asNumber(daily.lifetime_visit_days),
      distinctTopicsReplied: asNumber(
        content.lifetime_distinct_topics_replied,
      ),
      likesGiven: asNumber(likes.lifetime_likes_given),
      likesReceived: asNumber(likes.lifetime_likes_received),
    },
    window: {
      windowDays: rule.windowDays,
      topicsEntered: asNumber(daily.window_topics_entered),
      postsRead: asNumber(daily.window_posts_read),
      readingSeconds: asNumber(daily.window_reading_seconds),
      readingDays: asNumber(daily.window_reading_days),
      distinctTopicsReplied: asNumber(
        content.window_distinct_topics_replied,
      ),
      likesGiven: asNumber(likes.window_likes_given),
      likesReceived: asNumber(likes.window_likes_received),
      likeGiverCount: asNumber(likes.window_like_givers),
      likeDayCount: asNumber(likes.window_like_days),
      newTopics: denominators.newTopics,
      newPosts: denominators.newPosts,
      confirmedSevereReports: asNumber(quality.confirmed_severe_reports),
      recentSanctions:
        asNumber(quality.recent_sanctions) + (user.status === "active" ? 0 : 1),
    },
    lastQualifyingActivityAt: Math.max(
      lastDailyAt,
      asNumber(content.last_post_at),
      asNumber(content.last_topic_at),
      asNumber(content.last_read_at),
    ),
    firstPromotedToLevelThreeAt:
      quality.first_promoted_to_level_three_at === null ||
      quality.first_promoted_to_level_three_at === undefined
        ? null
        : asNumber(quality.first_promoted_to_level_three_at),
  };
}

async function saveRollup(
  database: D1Database,
  userId: string,
  metrics: TrustMetrics,
  now: number,
): Promise<void> {
  await database
    .prepare(
      `INSERT INTO user_activity_rollups(
         user_id, window_days, as_of_date, metrics_json, updated_at
       ) VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT(user_id, window_days) DO UPDATE SET
         as_of_date = excluded.as_of_date,
         metrics_json = excluded.metrics_json,
         updated_at = excluded.updated_at
       WHERE excluded.as_of_date > user_activity_rollups.as_of_date
          OR (
            excluded.as_of_date = user_activity_rollups.as_of_date
            AND excluded.metrics_json != user_activity_rollups.metrics_json
          )`,
    )
    .bind(
      userId,
      metrics.window.windowDays,
      metrics.asOfDate,
      JSON.stringify(metrics),
      now,
    )
    .run();
}

function notificationMessage(
  kind: LevelNotificationKind,
  fromLevel: number,
  toLevel: number,
  deadlineAt?: number,
): string {
  switch (kind) {
    case "trust_level_promoted":
      return `你的社区等级已从 Lv${fromLevel} 升至 Lv${toLevel}。`;
    case "trust_level_demoted":
      return `你的社区等级已从 Lv${fromLevel} 调整为 Lv${toLevel}。`;
    case "trust_level_demotion_warning":
      return `你的 Lv${fromLevel} 资格可能在 ${new Date(
        (deadlineAt ?? 0) * 1_000,
      ).toISOString()} 降至 Lv${toLevel}；恢复有效阅读或发言可避免此次调整。`;
  }
}

async function persistWarning(
  database: D1Database,
  user: CandidateRow,
  warning: NonNullable<TrustReviewDecision["warning"]>,
  now: number,
): Promise<boolean> {
  const notificationId = `trust-warning:${user.id}:${warning.deadlineAt}`;
  const results = await database.batch([
    database
      .prepare(
        `INSERT OR IGNORE INTO notifications(
           id, user_id, kind, data_json, created_at
         ) VALUES (?1, ?2, 'trust_level_demotion_warning', ?3, ?4)`,
      )
      .bind(
        notificationId,
        user.id,
        JSON.stringify({
          fromLevel: warning.fromLevel,
          toLevel: warning.toLevel,
          deadlineAt: warning.deadlineAt,
          emailQueuedAt: null,
        }),
        now,
      ),
    database
      .prepare(
        `INSERT INTO audit_logs(
           id, occurred_at, actor_role, action, target_type, target_id,
           request_id, after_json
         )
         SELECT ?1, ?2, 'system', 'trust_level.demotion_warning',
                'user', ?3, ?4, ?5
         WHERE changes() = 1`,
      )
      .bind(
        `audit:${notificationId}`,
        now,
        user.id,
        `scheduled:${notificationId}`,
        JSON.stringify({ deadlineAt: warning.deadlineAt, toLevel: 1 }),
      ),
  ]);
  return Number(results[0]?.meta.changes ?? 0) === 1;
}

async function persistTransition(
  database: D1Database,
  user: CandidateRow,
  decision: TrustReviewDecision,
  metrics: TrustMetrics,
  ruleUpdatedAt: Record<1 | 2 | 3 | 4, number>,
  now: number,
): Promise<boolean> {
  if (decision.targetLevel === null || decision.reason === null) return false;
  const fromLevel = asTrustLevel(user.trust_level);
  const toLevel = decision.targetLevel;
  const promotion = toLevel > fromLevel;
  const historyId = crypto.randomUUID();
  const notificationId = `trust-change:${historyId}`;
  const kind: LevelNotificationKind = promotion
    ? "trust_level_promoted"
    : "trust_level_demoted";
  const snapshot = JSON.stringify({
    schemaVersion: 1,
    ruleUpdatedAt,
    metrics,
  });
  const data = JSON.stringify({
    fromLevel,
    toLevel,
    historyId,
    reason: decision.reason,
    emailQueuedAt: null,
  });

  const results = await database.batch([
    database
      .prepare(
        `UPDATE users
         SET trust_level = ?2,
             next_level_review_at = ?3,
             updated_at = ?4
         WHERE id = ?1
           AND trust_level = ?5
           AND level_locked = 0
           AND status IN ('active', 'silenced')
           AND (?6 = 0 OR status = 'active')`,
      )
      .bind(
        user.id,
        toLevel,
        decision.nextReviewAt,
        now,
        fromLevel,
        promotion ? 1 : 0,
      ),
    database
      .prepare(
        `INSERT INTO user_level_history(
           id, user_id, from_level, to_level, reason,
           metrics_snapshot_json, created_at
         )
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7
         WHERE changes() = 1`,
      )
      .bind(
        historyId,
        user.id,
        fromLevel,
        toLevel,
        decision.reason,
        snapshot,
        now,
      ),
    database
      .prepare(
        `INSERT INTO notifications(id, user_id, kind, data_json, created_at)
         SELECT ?1, ?2, ?3, ?4, ?5
         WHERE changes() = 1`,
      )
      .bind(notificationId, user.id, kind, data, now),
    database
      .prepare(
        `INSERT INTO audit_logs(
           id, occurred_at, actor_role, action, target_type, target_id,
           request_id, before_json, after_json, metadata_json
         )
         SELECT ?1, ?2, 'system', ?3, 'user', ?4, ?5, ?6, ?7, ?8
         WHERE changes() = 1`,
      )
      .bind(
        `audit:${historyId}`,
        now,
        promotion ? "trust_level.promote" : "trust_level.demote",
        user.id,
        `scheduled:${historyId}`,
        JSON.stringify({ trustLevel: fromLevel }),
        JSON.stringify({ trustLevel: toLevel }),
        JSON.stringify({ reason: decision.reason, historyId }),
      ),
  ]);
  return Number(results[0]?.meta.changes ?? 0) === 1;
}

async function rescheduleUnchanged(
  database: D1Database,
  user: CandidateRow,
  nextReviewAt: number | null,
): Promise<void> {
  await database
    .prepare(
      `UPDATE users
       SET next_level_review_at = ?3
       WHERE id = ?1
         AND trust_level = ?2
         AND level_locked = 0
         AND status = ?4`,
    )
    .bind(user.id, user.trust_level, nextReviewAt, user.status)
    .run();
}

async function queuePendingLevelEmails(
  env: Bindings,
  now: number,
  limit: number,
): Promise<number> {
  const placeholders = LEVEL_NOTIFICATION_KINDS.map(() => "?").join(", ");
  const result = await env.CFORUM_DB.prepare(
    `SELECT
       n.id, n.kind, n.data_json, e.email_normalized
     FROM notifications n
     JOIN user_emails e
       ON e.user_id = n.user_id
      AND e.is_primary = 1
      AND e.verified_at IS NOT NULL
     WHERE n.kind IN (${placeholders})
       AND json_extract(n.data_json, '$.emailQueuedAt') IS NULL
     ORDER BY n.created_at, n.id
     LIMIT ?4`,
  )
    .bind(...LEVEL_NOTIFICATION_KINDS, limit)
    .all<{
      id: string;
      kind: LevelNotificationKind;
      data_json: string;
      email_normalized: string;
    }>();

  let queued = 0;
  for (const row of result.results) {
    let data: {
      fromLevel?: number;
      toLevel?: number;
      deadlineAt?: number;
    };
    try {
      data = JSON.parse(row.data_json) as typeof data;
    } catch {
      continue;
    }
    if (
      !LEVEL_NOTIFICATION_KINDS.includes(row.kind) ||
      !Number.isInteger(data.fromLevel) ||
      !Number.isInteger(data.toLevel)
    ) {
      continue;
    }
    try {
      await env.EMAIL_QUEUE.send({
        idempotencyKey: `trust-notification:${row.id}`,
        kind: "level_change",
        recipient: row.email_normalized,
        payload: {
          message: notificationMessage(
            row.kind,
            data.fromLevel ?? 0,
            data.toLevel ?? 0,
            data.deadlineAt,
          ),
        },
      });
      const marked = await env.CFORUM_DB.prepare(
        `UPDATE notifications
         SET data_json = json_set(data_json, '$.emailQueuedAt', ?2)
         WHERE id = ?1
           AND json_extract(data_json, '$.emailQueuedAt') IS NULL`,
      )
        .bind(row.id, now)
        .run();
      if (Number(marked.meta.changes ?? 0) === 1) queued += 1;
    } catch {
      // The notification row is the durable outbox; a later Cron retries it
      // with the same provider idempotency key.
    }
  }
  return queued;
}

async function selectCandidates(
  database: D1Database,
  cutoff: number,
  cursor: TrustReviewCursor | null,
  limit: number,
): Promise<CandidateRow[]> {
  const cursorClause = cursor
    ? `AND (
         COALESCE(next_level_review_at, 0) > ?2
         OR (
           COALESCE(next_level_review_at, 0) = ?2
           AND id > ?3
         )
       )`
    : "";
  const statement = database.prepare(
    `SELECT
       u.id, u.trust_level, u.role, u.status, u.level_locked,
       u.next_level_review_at, u.created_at, u.updated_at,
       (SELECT json_group_array(group_id)
        FROM group_members WHERE user_id = u.id) AS group_ids_json,
       (SELECT json_group_array(category_id)
        FROM moderator_category_scopes WHERE user_id = u.id)
         AS moderated_category_ids_json
     FROM users u
     WHERE level_locked = 0
       AND trust_level < 4
       AND status IN ('active', 'silenced')
       AND COALESCE(next_level_review_at, 0) <= ?1
       ${cursorClause}
     ORDER BY COALESCE(next_level_review_at, 0), id
     LIMIT ?${cursor ? 4 : 2}`,
  );
  const result = cursor
    ? await statement
        .bind(cutoff, cursor.dueAt, cursor.userId, limit)
        .all<CandidateRow>()
    : await statement.bind(cutoff, limit).all<CandidateRow>();
  return result.results;
}

export async function runTrustLevelReview(
  env: Bindings,
  options: {
    now?: number;
    batchSize?: number;
    cursor?: TrustReviewCursor | null;
  } = {},
): Promise<TrustReviewSummary> {
  const now = options.now ?? nowSeconds();
  const batchSize = Math.min(
    MAX_BATCH_SIZE,
    Math.max(1, Math.floor(options.batchSize ?? DEFAULT_BATCH_SIZE)),
  );
  const { rules, updatedAt } = await loadTrustRules(env.CFORUM_DB);
  const candidates = await selectCandidates(
    env.CFORUM_DB,
    now,
    options.cursor ?? null,
    batchSize + 1,
  );
  const page = candidates.slice(0, batchSize);
  const summary: TrustReviewSummary = {
    selected: page.length,
    processed: 0,
    transitioned: 0,
    warningsCreated: 0,
    failed: 0,
    emailsQueued: 0,
    nextCursor: null,
  };
  const denominatorCache = new Map<
    string,
    Promise<VisibleDenominators>
  >();

  for (const user of page) {
    try {
      const metrics = await loadTrustMetrics(
        env.CFORUM_DB,
        user,
        rules[3],
        now,
        denominatorCache,
      );
      await saveRollup(env.CFORUM_DB, user.id, metrics, now);
      const decision = evaluateTrustLevel(user, rules, metrics, now);
      if (decision.warning) {
        const created = await persistWarning(
          env.CFORUM_DB,
          user,
          decision.warning,
          now,
        );
        if (created) summary.warningsCreated += 1;
      }
      if (decision.targetLevel !== null) {
        const changed = await persistTransition(
          env.CFORUM_DB,
          user,
          decision,
          metrics,
          updatedAt,
          now,
        );
        if (changed) summary.transitioned += 1;
      } else {
        await rescheduleUnchanged(
          env.CFORUM_DB,
          user,
          decision.nextReviewAt,
        );
      }
      summary.processed += 1;
    } catch (error) {
      summary.failed += 1;
      console.error("trust_level_review_failed", {
        name: error instanceof Error ? error.name : "unknown",
      });
      await rescheduleUnchanged(
        env.CFORUM_DB,
        user,
        now + FAILED_REVIEW_BACKOFF_SECONDS,
      ).catch(() => undefined);
    }
  }

  const last = page.at(-1);
  if (candidates.length > batchSize && last) {
    summary.nextCursor = {
      dueAt: Number(last.next_level_review_at ?? 0),
      userId: last.id,
    };
  }
  summary.emailsQueued = await queuePendingLevelEmails(env, now, batchSize);
  return summary;
}
