import type { ViewerContext } from "@/worker/permissions/policy";

export type SqlBinding = string | number | null;

export interface BoundVisibilityScope {
  /** SQL fragment for aliases `t` (topics) and `c` (categories). */
  clause: string;
  bindings: SqlBinding[];
}

/**
 * Builds the shared visibility predicate for public-facing topic lists,
 * searches, counts, profiles, bookmarks and notifications.
 *
 * The only interpolated values are placeholder counts; all identity data is
 * returned separately as D1 bindings.
 */
export function topicVisibilityScope(
  viewer: ViewerContext,
): BoundVisibilityScope {
  const base = [
    "t.status IN ('open', 'locked', 'archived')",
    "t.approval_status = 'approved'",
    "c.state != 'deleted'",
  ];

  if (viewer.role === "admin" && viewer.status === "active") {
    return { clause: `(${base.join(" AND ")})`, bindings: [] };
  }

  const readableMember =
    viewer.userId !== null &&
    (viewer.status === "active" || viewer.status === "silenced");
  const level = readableMember ? (viewer.trustLevel ?? 0) : 0;
  const aclPrincipals = ["cp.principal_type = 'everyone'"];
  const aclBindings: SqlBinding[] = [];

  if (readableMember) {
    aclPrincipals.push("cp.principal_type = 'authenticated'");
    const groupIds = [...viewer.groupIds];
    if (groupIds.length > 0) {
      aclPrincipals.push(
        `(cp.principal_type = 'group' AND cp.principal_id IN (${groupIds
          .map(() => "?")
          .join(", ")}))`,
      );
      aclBindings.push(...groupIds);
    }
  }

  const normalAccess = `(
    MAX(c.min_view_level, t.min_view_level, t.effective_min_view_level) <= ?
    AND (
      c.acl_mode = 'open'
      OR EXISTS (
        SELECT 1
        FROM category_permissions cp
        WHERE cp.category_id = c.id
          AND cp.action = 'see'
          AND (${aclPrincipals.join(" OR ")})
      )
    )
  )`;

  const bindings: SqlBinding[] = [level, ...aclBindings];
  const accessPaths = [normalAccess];

  if (
    viewer.role === "moderator" &&
    viewer.status === "active" &&
    viewer.moderatedCategoryIds.size > 0
  ) {
    const categoryIds = [...viewer.moderatedCategoryIds];
    accessPaths.push(
      `c.id IN (${categoryIds.map(() => "?").join(", ")})`,
    );
    bindings.push(...categoryIds);
  }

  return {
    clause: `(${base.join(" AND ")} AND (${accessPaths.join(" OR ")}))`,
    bindings,
  };
}
