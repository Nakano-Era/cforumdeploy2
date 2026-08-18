import { Hono } from "hono";
import type { AppEnv } from "@/worker/env";
import { nowSeconds } from "@/worker/security/crypto";
import {
  safeParseTrustRule,
  trustRulePatchRequestSchema,
} from "@/worker/trust/schemas";

interface RuleRow {
  level: number;
  rule_json: string;
  updated_at: number;
  updated_by: string | null;
}

const router = new Hono<AppEnv>();

function activeAdmin(context: {
  get(key: "identity"): AppEnv["Variables"]["identity"];
}): { userId: string } | null {
  const identity = context.get("identity");
  if (
    !identity.session ||
    !identity.viewer.userId ||
    identity.viewer.role !== "admin" ||
    identity.viewer.status !== "active"
  ) {
    return null;
  }
  return { userId: identity.viewer.userId };
}

function levelParam(value: string): 1 | 2 | 3 | 4 | null {
  const level = Number(value);
  return level === 1 || level === 2 || level === 3 || level === 4
    ? level
    : null;
}

function parseRuleRow(row: RuleRow): unknown {
  const level = levelParam(String(row.level));
  if (!level) throw new Error("invalid_trust_rule_level");
  let json: unknown;
  try {
    json = JSON.parse(row.rule_json) as unknown;
  } catch {
    throw new Error("invalid_trust_rule_json");
  }
  const parsed = safeParseTrustRule(level, json);
  if (!parsed.success) throw new Error("invalid_trust_rule_shape");
  return parsed.data;
}

router.get("/admin/trust-levels/rules", async (context) => {
  const identity = context.get("identity");
  if (!identity.session || !identity.viewer.userId) {
    return context.json({ error: { code: "AUTHENTICATION_REQUIRED" } }, 401);
  }
  if (!activeAdmin(context)) {
    return context.json({ error: { code: "ACTION_NOT_ALLOWED" } }, 403);
  }

  const result = await context.env.CFORUM_DB.prepare(
    `SELECT level, rule_json, updated_at, updated_by
     FROM trust_level_rules
     ORDER BY level`,
  ).all<RuleRow>();
  if (result.results.length !== 4) {
    return context.json({ error: { code: "TRUST_RULES_INVALID" } }, 503);
  }
  try {
    return context.json({
      rules: result.results.map((row) => ({
        level: row.level,
        rule: parseRuleRow(row),
        updatedAt: row.updated_at,
        updatedBy: row.updated_by,
      })),
    });
  } catch {
    return context.json({ error: { code: "TRUST_RULES_INVALID" } }, 503);
  }
});

router.patch("/admin/trust-levels/rules/:level", async (context) => {
  const identity = context.get("identity");
  if (!identity.session || !identity.viewer.userId) {
    return context.json({ error: { code: "AUTHENTICATION_REQUIRED" } }, 401);
  }
  const admin = activeAdmin(context);
  if (!admin) {
    return context.json({ error: { code: "ACTION_NOT_ALLOWED" } }, 403);
  }
  const level = levelParam(context.req.param("level"));
  if (!level) {
    return context.json({ error: { code: "NOT_FOUND" } }, 404);
  }

  const request = trustRulePatchRequestSchema.safeParse(
    await context.req.json().catch(() => null),
  );
  if (!request.success) {
    return context.json({ error: { code: "INVALID_INPUT" } }, 422);
  }
  const parsedRule = safeParseTrustRule(level, request.data.rule);
  if (!parsedRule.success) {
    return context.json(
      {
        error: {
          code: "INVALID_INPUT",
          fields: parsedRule.error.flatten().fieldErrors,
        },
      },
      422,
    );
  }

  const current = await context.env.CFORUM_DB.prepare(
    `SELECT level, rule_json, updated_at, updated_by
     FROM trust_level_rules
     WHERE level = ?1
     LIMIT 1`,
  )
    .bind(level)
    .first<RuleRow>();
  if (!current) {
    return context.json({ error: { code: "NOT_FOUND" } }, 404);
  }
  if (current.updated_at !== request.data.expectedUpdatedAt) {
    return context.json({ error: { code: "EDIT_CONFLICT" } }, 409);
  }
  try {
    parseRuleRow(current);
  } catch {
    return context.json({ error: { code: "TRUST_RULES_INVALID" } }, 503);
  }

  const updatedAt = Math.max(nowSeconds(), current.updated_at + 1);
  const ruleJson = JSON.stringify(parsedRule.data);
  const results = await context.env.CFORUM_DB.batch([
    context.env.CFORUM_DB.prepare(
      `UPDATE trust_level_rules
       SET rule_json = ?2, updated_by = ?3, updated_at = ?4
       WHERE level = ?1 AND updated_at = ?5`,
    ).bind(
      level,
      ruleJson,
      admin.userId,
      updatedAt,
      request.data.expectedUpdatedAt,
    ),
    context.env.CFORUM_DB.prepare(
      `INSERT INTO audit_logs(
         id, occurred_at, actor_user_id, actor_role, action, target_type,
         target_id, request_id, before_json, after_json
       )
       SELECT ?1, ?2, ?3, 'admin', 'trust_level.rule.update',
              'trust_level_rule', ?4, ?5, ?6, ?7
       WHERE changes() = 1`,
    ).bind(
      crypto.randomUUID(),
      updatedAt,
      admin.userId,
      String(level),
      context.get("requestId"),
      current.rule_json,
      ruleJson,
    ),
  ]);
  if (Number(results[0]?.meta.changes ?? 0) !== 1) {
    return context.json({ error: { code: "EDIT_CONFLICT" } }, 409);
  }

  return context.json({
    rule: {
      level,
      rule: parsedRule.data,
      updatedAt,
      updatedBy: admin.userId,
    },
  });
});

export default router;
