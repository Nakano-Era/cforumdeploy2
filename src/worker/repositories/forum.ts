import type { TrustLevel } from "@/shared/domain";
import type { CategoryGrant, CategoryPolicy, TopicPolicy } from "@/worker/permissions/policy";

interface CategoryRow {
  id: string;
  slug: string;
  name: string;
  description: string;
  color: string;
  state: CategoryPolicy["state"];
  acl_mode: CategoryPolicy["aclMode"];
  min_view_level: number;
  min_reply_level: number;
  min_create_level: number;
  allowed_topic_min_level_max: number;
  require_topic_approval: number;
  require_reply_approval: number;
  allow_images: number;
}

interface GrantRow {
  category_id: string;
  principal_type: CategoryGrant["principal"];
  principal_id: string | null;
  action: CategoryGrant["permission"];
}

interface TopicRow {
  id: string;
  category_id: string;
  author_id: string;
  min_view_level: number;
  effective_min_view_level: number;
  author_qualified_visibility_level: number;
  author_downgrade_locked: number;
  status: TopicPolicy["state"];
  author_trust_level: number;
}

export interface CategoryRecord extends CategoryPolicy {
  slug: string;
  name: string;
  description: string;
  color: string;
  requireTopicApproval: boolean;
  requireReplyApproval: boolean;
  allowImages: boolean;
}

export interface TopicAggregate {
  category: CategoryRecord;
  topic: TopicPolicy;
}

function trustLevel(value: number): TrustLevel {
  if (Number.isInteger(value) && value >= 0 && value <= 4) {
    return value as TrustLevel;
  }
  return 4;
}

function grantsForCategory(
  categoryId: string,
  rows: readonly GrantRow[],
): CategoryGrant[] {
  return rows
    .filter((row) => row.category_id === categoryId)
    .map((row) => ({
      principal: row.principal_type,
      ...(row.principal_id ? { principalId: row.principal_id } : {}),
      permission: row.action,
    }));
}

function mapCategory(row: CategoryRow, grants: CategoryGrant[]): CategoryRecord {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    color: row.color,
    state: row.state,
    aclMode: row.acl_mode,
    minViewLevel: trustLevel(row.min_view_level),
    minReplyLevel: trustLevel(row.min_reply_level),
    minCreateLevel: trustLevel(row.min_create_level),
    allowedTopicMinLevelMax: trustLevel(row.allowed_topic_min_level_max),
    grants,
    requireTopicApproval: row.require_topic_approval === 1,
    requireReplyApproval: row.require_reply_approval === 1,
    allowImages: row.allow_images === 1,
  };
}

const categoryColumns = `
  id, slug, name, description, color, state, acl_mode,
  min_view_level, min_reply_level, min_create_level,
  allowed_topic_min_level_max, require_topic_approval,
  require_reply_approval, allow_images
`;

export async function getCategory(
  database: D1Database,
  categoryId: string,
): Promise<CategoryRecord | null> {
  const category = await database
    .prepare(`SELECT ${categoryColumns} FROM categories WHERE id = ?1 LIMIT 1`)
    .bind(categoryId)
    .first<CategoryRow>();
  if (!category) return null;
  const permissions = await database
    .prepare(
      `SELECT category_id, principal_type, principal_id, action
       FROM category_permissions WHERE category_id = ?1`,
    )
    .bind(categoryId)
    .all<GrantRow>();
  return mapCategory(category, grantsForCategory(categoryId, permissions.results));
}

export async function listCategories(
  database: D1Database,
): Promise<CategoryRecord[]> {
  const [categories, permissions] = await database.batch([
    database.prepare(
      `SELECT ${categoryColumns}
       FROM categories
       WHERE state != 'deleted'
       ORDER BY position, id`,
    ),
    database.prepare(
      `SELECT category_id, principal_type, principal_id, action
       FROM category_permissions`,
    ),
  ]);
  const permissionRows = permissions.results as unknown as GrantRow[];
  return (categories.results as unknown as CategoryRow[]).map((row) =>
    mapCategory(row, grantsForCategory(row.id, permissionRows)),
  );
}

export async function getTopicAggregate(
  database: D1Database,
  topicId: string,
): Promise<TopicAggregate | null> {
  const row = await database
    .prepare(
      `SELECT
         t.id, t.category_id, t.author_id, t.min_view_level,
         t.effective_min_view_level, t.author_qualified_visibility_level,
         t.author_downgrade_locked, t.status,
         author.trust_level AS author_trust_level
       FROM topics t
       JOIN users author ON author.id = t.author_id
       WHERE t.id = ?1
       LIMIT 1`,
    )
    .bind(topicId)
    .first<TopicRow>();
  if (!row) return null;
  const category = await getCategory(database, row.category_id);
  if (!category) return null;

  const safeEffective = Math.max(
    category.minViewLevel,
    row.min_view_level,
    row.effective_min_view_level,
  );
  const authorDowngradeLocked =
    row.author_trust_level < safeEffective &&
    safeEffective <= row.author_qualified_visibility_level;

  return {
    category,
    topic: {
      id: row.id,
      categoryId: row.category_id,
      authorId: row.author_id,
      minViewLevel: trustLevel(row.min_view_level),
      effectiveMinViewLevel: trustLevel(row.effective_min_view_level),
      authorQualifiedVisibilityLevel: trustLevel(
        row.author_qualified_visibility_level,
      ),
      // The derived value is authoritative so a restored level automatically
      // removes this lock without clearing an unrelated manual lock.
      authorDowngradeLocked,
      state: row.status,
    },
  };
}

export async function getNumericSetting(
  database: D1Database,
  key: string,
  fallback: number,
): Promise<number> {
  const row = await database
    .prepare("SELECT value_json FROM site_settings WHERE key = ?1 LIMIT 1")
    .bind(key)
    .first<{ value_json: string }>();
  if (!row) return fallback;
  const value = JSON.parse(row.value_json) as unknown;
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
