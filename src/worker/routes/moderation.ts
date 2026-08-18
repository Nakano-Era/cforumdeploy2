import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "@/worker/env";
import { reconcileBoundUploadScope } from "@/worker/media/lifecycle";
import { evaluateModerate, evaluateViewTopic } from "@/worker/permissions/policy";
import { getTopicAggregate } from "@/worker/repositories/forum";
import { nowSeconds } from "@/worker/security/crypto";

const router = new Hono<AppEnv>();

const idSchema = z.string().min(1).max(80).regex(/^[A-Za-z0-9_-]+$/);
const reviewTypeSchema = z.enum([
  "registration",
  "first_post",
  "media_post",
  "report",
]);
const reviewStatusSchema = z.enum([
  "pending",
  "claimed",
  "approved",
  "rejected",
  "cancelled",
]);

export const reportInputSchema = z
  .object({
    type: z.enum(["off_topic", "inappropriate", "spam", "illegal", "other"]),
    detail: z.string().trim().max(1_000),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.type === "illegal" || value.type === "other") && !value.detail) {
      context.addIssue({
        code: "custom",
        path: ["detail"],
        message: "此举报类型需要补充说明",
      });
    }
  });

export const reviewDecisionSchema = z
  .object({
    decision: z.enum(["approve", "reject"]),
    note: z.string().trim().max(1_000).optional(),
  })
  .strict();

export const reviewListQuerySchema = z
  .object({
    status: reviewStatusSchema.default("pending"),
    type: reviewTypeSchema.optional(),
    category: idSchema.optional(),
    cursor: z.string().max(512).optional(),
  })
  .strict();

interface ReviewCursor {
  priority: number;
  createdAt: number;
  id: string;
}

const reviewCursorSchema = z.object({
  priority: z.number().int(),
  createdAt: z.number().int().nonnegative(),
  id: idSchema,
});

function encodeCursor(cursor: ReviewCursor): string {
  return btoa(JSON.stringify(cursor))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function decodeCursor(value: string | undefined): ReviewCursor | null {
  if (!value) return null;
  try {
    const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const parsed = reviewCursorSchema.safeParse(JSON.parse(atob(padded)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function isoFromSeconds(value: number | null): string | null {
  return value === null ? null : new Date(value * 1_000).toISOString();
}

function isActiveStaff(
  viewer: AppEnv["Variables"]["identity"]["viewer"],
): boolean {
  return (
    viewer.status === "active" &&
    (viewer.role === "admin" || viewer.role === "moderator")
  );
}

interface ReportTargetRow {
  id: string;
  topic_id: string;
  author_id: string;
  post_number: number;
  plain_text_excerpt: string;
  status: "pending" | "published" | "hidden" | "deleted";
  title: string;
  category_id: string;
}

interface ReportResultRow {
  id: string;
  status: "open" | "accepted" | "rejected" | "withdrawn";
}

router.post("/posts/:id/reports", async (context) => {
  const identity = context.get("identity");
  if (!identity.viewer.userId) {
    return context.json({ error: { code: "AUTHENTICATION_REQUIRED" } }, 401);
  }
  if (identity.viewer.status !== "active") {
    return context.json({ error: { code: "ACTION_NOT_ALLOWED" } }, 403);
  }

  const postId = context.req.param("id");
  if (!idSchema.safeParse(postId).success) {
    return context.json({ error: { code: "NOT_FOUND" } }, 404);
  }
  const parsed = reportInputSchema.safeParse(
    await context.req.json().catch(() => null),
  );
  if (!parsed.success) {
    return context.json(
      {
        error: {
          code: "INVALID_INPUT",
          fields: parsed.error.flatten().fieldErrors,
        },
      },
      422,
    );
  }

  const target = await context.env.CFORUM_DB.prepare(
    `SELECT
       p.id, p.topic_id, p.author_id, p.post_number, p.plain_text_excerpt,
       p.status, t.title, t.category_id
     FROM posts p
     JOIN topics t ON t.id = p.topic_id
     WHERE p.id = ?1 AND p.status = 'published'
     LIMIT 1`,
  )
    .bind(postId)
    .first<ReportTargetRow>();
  if (!target) return context.json({ error: { code: "NOT_FOUND" } }, 404);

  const aggregate = await getTopicAggregate(context.env.CFORUM_DB, target.topic_id);
  if (
    !aggregate ||
    !evaluateViewTopic(identity.viewer, aggregate.category, aggregate.topic).allowed
  ) {
    return context.json({ error: { code: "NOT_FOUND" } }, 404);
  }

  const reportId = crypto.randomUUID();
  const now = nowSeconds();
  const priority =
    parsed.data.type === "illegal"
      ? 100
      : parsed.data.type === "spam" || parsed.data.type === "inappropriate"
        ? 50
        : 10;
  const statements = [
    context.env.CFORUM_DB.prepare(
      `INSERT INTO reports(
         id, reporter_user_id, target_post_id, report_type, detail, status,
         created_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, 'open', ?6)
       ON CONFLICT(reporter_user_id, target_post_id, report_type) DO NOTHING`,
    ).bind(
      reportId,
      identity.viewer.userId,
      target.id,
      parsed.data.type,
      parsed.data.detail,
      now,
    ),
    context.env.CFORUM_DB.prepare(
      `INSERT INTO review_items(
         id, type, category_id, submitted_by, target_user_id,
         target_topic_id, target_post_id, trigger_reason,
         content_snapshot_json, status, priority, created_at
       )
       SELECT
         'review-report-' || r.id, 'report', ?1, r.reporter_user_id, ?2,
         ?3, r.target_post_id, 'user_report:' || r.report_type,
         json_object(
           'reportId', r.id,
           'reportType', r.report_type,
           'detail', r.detail,
           'title', ?4,
           'postNumber', ?5,
           'excerpt', ?6
         ),
         'pending', ?7, r.created_at
       FROM reports r
       WHERE r.reporter_user_id = ?8
         AND r.target_post_id = ?9
         AND r.report_type = ?10
         AND r.status = 'open'
       ON CONFLICT(id) DO NOTHING`,
    ).bind(
      target.category_id,
      target.author_id,
      target.topic_id,
      target.title,
      target.post_number,
      target.plain_text_excerpt,
      priority,
      identity.viewer.userId,
      target.id,
      parsed.data.type,
    ),
    context.env.CFORUM_DB.prepare(
      `INSERT INTO audit_logs(
         id, occurred_at, actor_user_id, actor_role, action, target_type,
         target_id, category_id, request_id, after_json
       )
       SELECT
         'audit-report-' || r.id, r.created_at, r.reporter_user_id, 'member',
         'content.report.create', 'post', r.target_post_id, ?1, ?2,
         json_object('reportType', r.report_type)
       FROM reports r
       WHERE r.reporter_user_id = ?3
         AND r.target_post_id = ?4
         AND r.report_type = ?5
       ON CONFLICT(id) DO NOTHING`,
    ).bind(
      target.category_id,
      context.get("requestId"),
      identity.viewer.userId,
      target.id,
      parsed.data.type,
    ),
  ];
  const results = await context.env.CFORUM_DB.batch(statements);
  const created = Number(results[0]?.meta.changes ?? 0) === 1;
  const report = await context.env.CFORUM_DB.prepare(
    `SELECT id, status FROM reports
     WHERE reporter_user_id = ?1 AND target_post_id = ?2 AND report_type = ?3
     LIMIT 1`,
  )
    .bind(identity.viewer.userId, target.id, parsed.data.type)
    .first<ReportResultRow>();
  if (!report) throw new Error("report_write_missing");

  return context.json(
    { report: { id: report.id, status: report.status }, created },
    created ? 201 : 200,
  );
});

interface ReviewListRow {
  id: string;
  type: z.infer<typeof reviewTypeSchema>;
  status: z.infer<typeof reviewStatusSchema>;
  priority: number;
  trigger_reason: string;
  content_snapshot_json: string;
  created_at: number;
  category_id: string | null;
  category_name: string | null;
  submitted_by_id: string | null;
  submitted_by_username: string | null;
  submitted_by_display_name: string | null;
  target_user_id: string | null;
  target_topic_id: string | null;
  target_post_id: string | null;
  target_title: string | null;
  target_post_number: number | null;
  target_excerpt: string | null;
}

router.get("/admin/review", async (context) => {
  const viewer = context.get("identity").viewer;
  if (!viewer.userId) {
    return context.json({ error: { code: "AUTHENTICATION_REQUIRED" } }, 401);
  }
  if (!isActiveStaff(viewer)) {
    return context.json({ error: { code: "ACTION_NOT_ALLOWED" } }, 403);
  }
  const parsed = reviewListQuerySchema.safeParse(context.req.query());
  if (!parsed.success) {
    return context.json({ error: { code: "INVALID_QUERY" } }, 422);
  }
  const cursor = decodeCursor(parsed.data.cursor);
  if (parsed.data.cursor && !cursor) {
    return context.json({ error: { code: "INVALID_CURSOR" } }, 422);
  }

  const where = ["ri.status = ?"];
  const bindings: Array<string | number> = [parsed.data.status];
  if (viewer.role === "moderator") {
    const categoryIds = [...viewer.moderatedCategoryIds];
    if (categoryIds.length === 0) {
      return context.json({
        items: [],
        nextCursor: null,
        capabilities: { scope: "categories", categoryIds: [] },
      });
    }
    where.push(`ri.category_id IN (${categoryIds.map(() => "?").join(", ")})`);
    bindings.push(...categoryIds);
  }
  if (parsed.data.type) {
    where.push("ri.type = ?");
    bindings.push(parsed.data.type);
  }
  if (parsed.data.category) {
    where.push("ri.category_id = ?");
    bindings.push(parsed.data.category);
  }
  if (cursor) {
    where.push(
      `(
        ri.priority < ? OR
        (ri.priority = ? AND (
          ri.created_at > ? OR
          (ri.created_at = ? AND ri.id > ?)
        ))
      )`,
    );
    bindings.push(
      cursor.priority,
      cursor.priority,
      cursor.createdAt,
      cursor.createdAt,
      cursor.id,
    );
  }
  bindings.push(21);

  const result = await context.env.CFORUM_DB.prepare(
    `SELECT
       ri.id, ri.type, ri.status, ri.priority, ri.trigger_reason,
       ri.content_snapshot_json, ri.created_at,
       c.id AS category_id, c.name AS category_name,
       submitted.id AS submitted_by_id,
       submitted.username AS submitted_by_username,
       submitted.display_name AS submitted_by_display_name,
       ri.target_user_id, ri.target_topic_id, ri.target_post_id,
       t.title AS target_title, p.post_number AS target_post_number,
       p.plain_text_excerpt AS target_excerpt
     FROM review_items ri
     LEFT JOIN categories c ON c.id = ri.category_id
     LEFT JOIN users submitted ON submitted.id = ri.submitted_by
     LEFT JOIN topics t ON t.id = ri.target_topic_id
     LEFT JOIN posts p ON p.id = ri.target_post_id
     WHERE ${where.join(" AND ")}
     ORDER BY ri.priority DESC, ri.created_at ASC, ri.id ASC
     LIMIT ?`,
  )
    .bind(...bindings)
    .all<ReviewListRow>();
  const hasMore = result.results.length > 20;
  const rows = result.results.slice(0, 20);
  const last = rows.at(-1);

  return context.json({
    items: rows.map((row) => ({
      id: row.id,
      type: row.type,
      status: row.status,
      priority: row.priority,
      triggerReason: row.trigger_reason,
      createdAt: new Date(row.created_at * 1_000).toISOString(),
      category:
        row.category_id && row.category_name
          ? { id: row.category_id, name: row.category_name }
          : null,
      submittedBy:
        row.submitted_by_id &&
        row.submitted_by_username &&
        row.submitted_by_display_name
          ? {
              id: row.submitted_by_id,
              username: row.submitted_by_username,
              displayName: row.submitted_by_display_name,
            }
          : null,
      target: {
        userId: row.target_user_id,
        topicId: row.target_topic_id,
        postId: row.target_post_id,
        title: row.target_title,
        postNumber: row.target_post_number,
        excerpt: row.target_excerpt,
      },
      snapshot: JSON.parse(row.content_snapshot_json) as unknown,
    })),
    nextCursor:
      hasMore && last
        ? encodeCursor({
            priority: last.priority,
            createdAt: last.created_at,
            id: last.id,
          })
        : null,
    capabilities: {
      scope: viewer.role === "admin" ? "global" : "categories",
      categoryIds:
        viewer.role === "admin" ? [] : [...viewer.moderatedCategoryIds],
    },
  });
});

interface ReviewTargetRow {
  id: string;
  type: z.infer<typeof reviewTypeSchema>;
  category_id: string | null;
  submitted_by: string | null;
  target_user_id: string | null;
  target_topic_id: string | null;
  target_post_id: string | null;
  content_snapshot_json: string;
  status: z.infer<typeof reviewStatusSchema>;
  claimed_by: string | null;
  action: string | null;
  handled_at: number | null;
}

function actionFor(
  type: ReviewTargetRow["type"],
  decision: z.infer<typeof reviewDecisionSchema>["decision"],
): string {
  if (type === "report") {
    return decision === "approve" ? "accept_report" : "dismiss_report";
  }
  return `${decision}_${type}`;
}

async function queueRegistrationDecision(
  context: AppRouteContext,
  userId: string,
  reviewId: string,
  status: "approved" | "rejected",
): Promise<void> {
  const email = await context.env.CFORUM_DB.prepare(
    `SELECT email_normalized FROM user_emails
     WHERE user_id = ?1 AND is_primary = 1 AND verified_at IS NOT NULL
     LIMIT 1`,
  )
    .bind(userId)
    .first<{ email_normalized: string }>();
  if (!email) return;
  await context.env.EMAIL_QUEUE.send({
    idempotencyKey: `registration-decision:${reviewId}:${status}`,
    kind: "registration_decision",
    recipient: email.email_normalized,
    payload: {
      message:
        status === "approved"
          ? "你的 CForum 注册申请已通过，现在可以登录。"
          : "你的 CForum 注册申请未通过；如需申诉，请联系站点管理员。",
    },
  });
}

async function reconcilePostMedia(
  env: AppEnv["Bindings"],
  postId: string,
): Promise<void> {
  const uploads = await env.CFORUM_DB.prepare(
    `SELECT id FROM uploads
     WHERE post_id = ?1 AND state = 'bound'
     ORDER BY id`,
  )
    .bind(postId)
    .all<{ id: string }>();
  await Promise.all(
    (uploads.results ?? []).map(({ id }) =>
      reconcileBoundUploadScope(env, id),
    ),
  );
}

function schedulePostMediaReconciliation(
  context: Context<AppEnv>,
  review: ReviewTargetRow,
  decision: "approve" | "reject",
): void {
  if (
    decision !== "approve" ||
    !review.target_post_id ||
    (review.type !== "first_post" && review.type !== "media_post")
  ) {
    return;
  }
  let executionContext: Context<AppEnv>["executionCtx"];
  try {
    executionContext = context.executionCtx;
  } catch {
    // Hono's in-memory request helper has no ExecutionContext.
    return;
  }
  const reconciliation = reconcilePostMedia(
    context.env,
    review.target_post_id,
  ).catch((error: unknown) => {
    console.error("media_scope_reconcile_failed", {
      requestId: context.get("requestId"),
      name: error instanceof Error ? error.name : "UnknownError",
    });
  });
  executionContext.waitUntil(reconciliation);
}

function addRegistrationStatements(
  context: AppRouteContext,
  review: ReviewTargetRow,
  decision: "approve" | "reject",
  actionId: string,
  actorId: string,
  note: string,
  now: number,
): D1PreparedStatement[] {
  const userStatus = decision === "approve" ? "active" : "deleted";
  const requestStatus = decision === "approve" ? "approved" : "rejected";
  return [
    context.env.CFORUM_DB.prepare(
      `UPDATE users
       SET status = ?1, updated_at = ?2
       WHERE id = ?3 AND status = 'pending'
         AND EXISTS (SELECT 1 FROM moderation_actions WHERE id = ?4)`,
    ).bind(userStatus, now, review.target_user_id, actionId),
    context.env.CFORUM_DB.prepare(
      `UPDATE registration_requests
       SET status = ?1, decided_at = ?2, decided_by = ?3, decision_note = ?4
       WHERE user_id = ?5 AND status IN ('pending_review', 'needs_info')
         AND EXISTS (SELECT 1 FROM moderation_actions WHERE id = ?6)`,
    ).bind(
      requestStatus,
      now,
      actorId,
      note || null,
      review.target_user_id,
      actionId,
    ),
  ];
}

type AppRouteContext = {
  env: AppEnv["Bindings"];
};

function addContentReviewStatements(
  context: AppRouteContext,
  review: ReviewTargetRow,
  decision: "approve" | "reject",
  actionId: string,
  now: number,
): D1PreparedStatement[] {
  const postStatus = decision === "approve" ? "published" : "hidden";
  const statements = [
    context.env.CFORUM_DB.prepare(
      `UPDATE posts
       SET status = ?1, updated_at = ?2,
           deleted_at = CASE WHEN ?1 = 'hidden' THEN ?2 ELSE NULL END
       WHERE id = ?3 AND status IN ('pending', 'published')
         AND EXISTS (SELECT 1 FROM moderation_actions WHERE id = ?4)`,
    ).bind(postStatus, now, review.target_post_id, actionId),
  ];
  if (decision === "approve") {
    statements.push(
      context.env.CFORUM_DB.prepare(
        `UPDATE topics
         SET status = CASE
               WHEN (SELECT post_number FROM posts WHERE id = ?1) = 1
                 AND status = 'pending' THEN 'open'
               ELSE status
             END,
             approval_status = CASE
               WHEN (SELECT post_number FROM posts WHERE id = ?1) = 1
                 THEN 'approved'
               ELSE approval_status
             END,
             last_post_number = COALESCE((
               SELECT MAX(post_number) FROM posts
               WHERE topic_id = topics.id AND status = 'published'
             ), 1),
             reply_count = (
               SELECT COUNT(*) FROM posts
               WHERE topic_id = topics.id AND status = 'published' AND post_number > 1
             ),
             unique_replier_count = (
               SELECT COUNT(DISTINCT author_id) FROM posts
               WHERE topic_id = topics.id AND status = 'published' AND post_number > 1
             ),
             bumped_at = ?2,
             updated_at = ?2
         WHERE id = ?3
           AND EXISTS (SELECT 1 FROM moderation_actions WHERE id = ?4)`,
      ).bind(review.target_post_id, now, review.target_topic_id, actionId),
    );
  } else {
    statements.push(
      context.env.CFORUM_DB.prepare(
        `UPDATE topics
         SET status = CASE
               WHEN (SELECT post_number FROM posts WHERE id = ?1) = 1
                 THEN 'deleted'
               ELSE status
             END,
             approval_status = CASE
               WHEN (SELECT post_number FROM posts WHERE id = ?1) = 1
                 THEN 'rejected'
               ELSE approval_status
             END,
             deleted_at = CASE
               WHEN (SELECT post_number FROM posts WHERE id = ?1) = 1
                 THEN ?2
               ELSE deleted_at
             END,
             updated_at = ?2
         WHERE id = ?3
           AND EXISTS (SELECT 1 FROM moderation_actions WHERE id = ?4)`,
      ).bind(review.target_post_id, now, review.target_topic_id, actionId),
    );
  }
  if (review.type === "media_post" && decision === "reject") {
    statements.push(
      context.env.CFORUM_DB.prepare(
        `UPDATE uploads SET state = 'quarantined'
         WHERE post_id = ?1 AND state = 'bound'
           AND EXISTS (SELECT 1 FROM moderation_actions WHERE id = ?2)`,
      ).bind(review.target_post_id, actionId),
    );
  }
  return statements;
}

function addReportStatements(
  context: AppRouteContext,
  review: ReviewTargetRow,
  decision: "approve" | "reject",
  actionId: string,
  now: number,
): D1PreparedStatement[] {
  const reportStatus = decision === "approve" ? "accepted" : "rejected";
  const statements: D1PreparedStatement[] = [
    context.env.CFORUM_DB.prepare(
      `UPDATE reports SET status = ?1, resolved_at = ?2
       WHERE id = json_extract(?3, '$.reportId') AND status = 'open'
         AND EXISTS (SELECT 1 FROM moderation_actions WHERE id = ?4)`,
    ).bind(reportStatus, now, review.content_snapshot_json, actionId),
  ];
  if (decision === "approve") {
    statements.push(
      context.env.CFORUM_DB.prepare(
        `UPDATE posts
         SET status = 'hidden', updated_at = ?1, deleted_at = ?1
         WHERE id = ?2 AND status = 'published'
           AND EXISTS (SELECT 1 FROM moderation_actions WHERE id = ?3)`,
      ).bind(now, review.target_post_id, actionId),
      context.env.CFORUM_DB.prepare(
        `UPDATE topics
         SET status = CASE
               WHEN (SELECT post_number FROM posts WHERE id = ?1) = 1
                 THEN 'deleted'
               ELSE status
             END,
             deleted_at = CASE
               WHEN (SELECT post_number FROM posts WHERE id = ?1) = 1
                 THEN ?2
               ELSE deleted_at
             END,
             reply_count = (
               SELECT COUNT(*) FROM posts
               WHERE topic_id = topics.id AND status = 'published' AND post_number > 1
             ),
             unique_replier_count = (
               SELECT COUNT(DISTINCT author_id) FROM posts
               WHERE topic_id = topics.id AND status = 'published' AND post_number > 1
             ),
             last_post_number = COALESCE((
               SELECT MAX(post_number) FROM posts
               WHERE topic_id = topics.id AND status = 'published'
             ), 1),
             bumped_at = COALESCE((
               SELECT MAX(created_at) FROM posts
               WHERE topic_id = topics.id AND status = 'published'
             ), bumped_at),
             updated_at = ?2
         WHERE id = ?3
           AND EXISTS (SELECT 1 FROM moderation_actions WHERE id = ?4)`,
      ).bind(review.target_post_id, now, review.target_topic_id, actionId),
    );
  }
  return statements;
}

router.post("/admin/review/:id/decision", async (context) => {
  const viewer = context.get("identity").viewer;
  if (!viewer.userId) {
    return context.json({ error: { code: "AUTHENTICATION_REQUIRED" } }, 401);
  }
  if (!isActiveStaff(viewer)) {
    return context.json({ error: { code: "ACTION_NOT_ALLOWED" } }, 403);
  }
  const reviewId = context.req.param("id");
  if (!idSchema.safeParse(reviewId).success) {
    return context.json({ error: { code: "NOT_FOUND" } }, 404);
  }
  const parsed = reviewDecisionSchema.safeParse(
    await context.req.json().catch(() => null),
  );
  if (!parsed.success) {
    return context.json(
      {
        error: {
          code: "INVALID_INPUT",
          fields: parsed.error.flatten().fieldErrors,
        },
      },
      422,
    );
  }

  const review = await context.env.CFORUM_DB.prepare(
    `SELECT
       id, type, category_id, submitted_by, target_user_id, target_topic_id,
       target_post_id, content_snapshot_json, status, claimed_by, action,
       handled_at
     FROM review_items WHERE id = ?1 LIMIT 1`,
  )
    .bind(reviewId)
    .first<ReviewTargetRow>();
  if (!review) return context.json({ error: { code: "NOT_FOUND" } }, 404);

  const authorized =
    review.category_id === null
      ? viewer.role === "admin" && viewer.status === "active"
      : evaluateModerate(viewer, review.category_id).allowed;
  if (!authorized) return context.json({ error: { code: "NOT_FOUND" } }, 404);

  const desiredStatus =
    parsed.data.decision === "approve" ? "approved" : "rejected";
  if (review.status === desiredStatus) {
    schedulePostMediaReconciliation(context, review, parsed.data.decision);
    return context.json({
      item: {
        id: review.id,
        status: review.status,
        action: review.action ?? actionFor(review.type, parsed.data.decision),
        handledAt: isoFromSeconds(review.handled_at),
      },
    });
  }
  if (review.status !== "pending" && review.status !== "claimed") {
    return context.json({ error: { code: "REVIEW_ALREADY_HANDLED" } }, 409);
  }
  if (
    review.status === "claimed" &&
    review.claimed_by !== null &&
    review.claimed_by !== viewer.userId &&
    viewer.role !== "admin"
  ) {
    return context.json({ error: { code: "REVIEW_CLAIMED" } }, 409);
  }

  const now = nowSeconds();
  const action = actionFor(review.type, parsed.data.decision);
  const actionId = crypto.randomUUID();
  const note = parsed.data.note ?? "";
  const statements: D1PreparedStatement[] = [
    context.env.CFORUM_DB.prepare(
      `UPDATE review_items
       SET status = ?1, claimed_by = COALESCE(claimed_by, ?2), action = ?3,
           internal_note = ?4, handled_at = ?5
       WHERE id = ?6 AND status IN ('pending', 'claimed')
         AND (claimed_by IS NULL OR claimed_by = ?2 OR ?7 = 1)`,
    ).bind(
      desiredStatus,
      viewer.userId,
      action,
      note || null,
      now,
      review.id,
      viewer.role === "admin" ? 1 : 0,
    ),
    context.env.CFORUM_DB.prepare(
      `INSERT INTO moderation_actions(
         id, review_item_id, actor_user_id, category_id, target_user_id,
         target_topic_id, target_post_id, action, reason, metadata_json,
         created_at
       )
       SELECT ?1, id, ?2, category_id, target_user_id, target_topic_id,
              target_post_id, ?3, ?4, ?5, ?6
       FROM review_items WHERE id = ?7 AND changes() = 1`,
    ).bind(
      actionId,
      viewer.userId,
      action,
      note || action,
      JSON.stringify({ decision: parsed.data.decision }),
      now,
      review.id,
    ),
  ];
  if (review.type === "registration") {
    statements.push(
      ...addRegistrationStatements(
        context,
        review,
        parsed.data.decision,
        actionId,
        viewer.userId,
        note,
        now,
      ),
    );
  } else if (review.type === "report") {
    statements.push(
      ...addReportStatements(
        context,
        review,
        parsed.data.decision,
        actionId,
        now,
      ),
    );
  } else {
    statements.push(
      ...addContentReviewStatements(
        context,
        review,
        parsed.data.decision,
        actionId,
        now,
      ),
    );
  }
  if (review.target_user_id && review.type !== "report") {
    statements.push(
      context.env.CFORUM_DB.prepare(
        `INSERT INTO notifications(
           id, user_id, actor_user_id, kind, topic_id, post_id, data_json,
           created_at
         )
         SELECT ?1, ?2, ?3, 'review_decision', ?4, ?5, ?6, ?7
         WHERE EXISTS (SELECT 1 FROM moderation_actions WHERE id = ?8)`,
      ).bind(
        crypto.randomUUID(),
        review.target_user_id,
        viewer.userId,
        review.target_topic_id,
        review.target_post_id,
        JSON.stringify({ reviewItemId: review.id, type: review.type, action }),
        now,
        actionId,
      ),
    );
  }
  if (review.type === "report" && review.submitted_by) {
    statements.push(
      context.env.CFORUM_DB.prepare(
        `INSERT INTO notifications(
           id, user_id, actor_user_id, kind, topic_id, post_id, data_json,
           created_at
         )
         SELECT ?1, ?2, ?3, 'report_decision', ?4, ?5, ?6, ?7
         WHERE EXISTS (SELECT 1 FROM moderation_actions WHERE id = ?8)`,
      ).bind(
        crypto.randomUUID(),
        review.submitted_by,
        viewer.userId,
        review.target_topic_id,
        review.target_post_id,
        JSON.stringify({ reviewItemId: review.id, action }),
        now,
        actionId,
      ),
    );
  }
  if (
    review.type === "report" &&
    parsed.data.decision === "approve" &&
    review.target_user_id &&
    review.target_user_id !== review.submitted_by
  ) {
    statements.push(
      context.env.CFORUM_DB.prepare(
        `INSERT INTO notifications(
           id, user_id, actor_user_id, kind, topic_id, post_id, data_json,
           created_at
         )
         SELECT ?1, ?2, ?3, 'content_moderated', ?4, ?5, ?6, ?7
         WHERE EXISTS (SELECT 1 FROM moderation_actions WHERE id = ?8)`,
      ).bind(
        crypto.randomUUID(),
        review.target_user_id,
        viewer.userId,
        review.target_topic_id,
        review.target_post_id,
        JSON.stringify({ reviewItemId: review.id, action }),
        now,
        actionId,
      ),
    );
  }
  statements.push(
    context.env.CFORUM_DB.prepare(
      `INSERT INTO audit_logs(
         id, occurred_at, actor_user_id, actor_role, action, target_type,
         target_id, category_id, request_id, after_json
       )
       SELECT ?1, ?2, ?3, ?4, 'review.decision', 'review_item', ?5, ?6,
              ?7, ?8
       WHERE EXISTS (SELECT 1 FROM moderation_actions WHERE id = ?9)`,
    ).bind(
      crypto.randomUUID(),
      now,
      viewer.userId,
      viewer.role,
      review.id,
      review.category_id,
      context.get("requestId"),
      JSON.stringify({ action, decision: parsed.data.decision }),
      actionId,
    ),
  );

  const results = await context.env.CFORUM_DB.batch(statements);
  if (Number(results[0]?.meta.changes ?? 0) !== 1) {
    const current = await context.env.CFORUM_DB.prepare(
      "SELECT status, action, handled_at FROM review_items WHERE id = ?1",
    )
      .bind(review.id)
      .first<{
        status: ReviewTargetRow["status"];
        action: string | null;
        handled_at: number | null;
      }>();
    if (current?.status === desiredStatus) {
      return context.json({
        item: {
          id: review.id,
          status: current.status,
          action: current.action ?? action,
          handledAt: isoFromSeconds(current.handled_at),
        },
      });
    }
    return context.json({ error: { code: "REVIEW_ALREADY_HANDLED" } }, 409);
  }

  if (review.type === "registration" && review.target_user_id) {
    const delivery = queueRegistrationDecision(
      context,
      review.target_user_id,
      review.id,
      desiredStatus,
    ).catch((error: unknown) => {
      console.error("registration_decision_queue_failed", {
        requestId: context.get("requestId"),
        name: error instanceof Error ? error.name : "UnknownError",
      });
    });
    try {
      context.executionCtx.waitUntil(delivery);
    } catch {
      // Hono's in-memory request helper has no ExecutionContext; the guarded
      // promise still runs and handles its own failure without changing the
      // already committed moderation decision.
    }
  }

  schedulePostMediaReconciliation(context, review, parsed.data.decision);

  return context.json({
    item: {
      id: review.id,
      status: desiredStatus,
      action,
      handledAt: new Date(now * 1_000).toISOString(),
    },
  });
});

export default router;
