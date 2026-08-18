import type { TrustLevel, UserRole, UserStatus } from "@/shared/domain";

export type CategoryAction = "see" | "reply" | "create";
export type CategoryPrincipal = "everyone" | "authenticated" | "group";

export interface CategoryGrant {
  principal: CategoryPrincipal;
  principalId?: string;
  /** Grants are hierarchical: create includes reply and see; reply includes see. */
  permission: CategoryAction;
}

export interface ViewerContext {
  userId: string | null;
  role: UserRole | "guest";
  status: UserStatus | "guest";
  trustLevel: TrustLevel | null;
  groupIds: ReadonlySet<string>;
  moderatedCategoryIds: ReadonlySet<string>;
}

export interface CategoryPolicy {
  id: string;
  state: "active" | "archived" | "deleted";
  /** Open means public read plus authenticated write; restricted is fail-closed. */
  aclMode: "open" | "restricted";
  minViewLevel: TrustLevel;
  minReplyLevel: TrustLevel;
  minCreateLevel: TrustLevel;
  allowedTopicMinLevelMax: TrustLevel;
  grants: readonly CategoryGrant[];
}

export interface TopicPolicy {
  id: string;
  categoryId: string;
  authorId: string;
  minViewLevel: TrustLevel;
  effectiveMinViewLevel: TrustLevel;
  state: "open" | "locked" | "archived" | "deleted" | "pending";
  authorQualifiedVisibilityLevel: TrustLevel;
  authorDowngradeLocked: boolean;
}

export interface UploadPolicy {
  id: string;
  ownerUserId: string;
  topic: TopicPolicy | null;
  state: "reserved" | "uploaded" | "bound" | "quarantined" | "deleted";
}

export type PermissionReason =
  | "allowed"
  | "admin"
  | "category_moderator"
  | "author_read_only"
  | "authentication_required"
  | "account_inactive"
  | "category_unavailable"
  | "topic_unavailable"
  | "topic_read_only"
  | "level_too_low"
  | "group_acl_denied"
  | "requested_level_invalid"
  | "not_owner"
  | "upload_unavailable"
  | "moderator_scope_denied";

export interface PermissionDecision {
  allowed: boolean;
  reason: PermissionReason;
  /** A caller must expose denied object-level decisions as 404. */
  concealExistence: boolean;
  readOnly?: boolean;
}

const allow = (
  reason: PermissionReason = "allowed",
  readOnly = false,
): PermissionDecision => ({
  allowed: true,
  reason,
  concealExistence: false,
  ...(readOnly ? { readOnly } : {}),
});

const deny = (reason: PermissionReason): PermissionDecision => ({
  allowed: false,
  reason,
  concealExistence: true,
});

function isAuthenticated(viewer: ViewerContext): boolean {
  return viewer.userId !== null && viewer.role !== "guest";
}

function isReadableAccount(viewer: ViewerContext): boolean {
  return viewer.status === "active" || viewer.status === "silenced";
}

function hasActiveRole(viewer: ViewerContext): boolean {
  return viewer.status === "active";
}

function isWritableAccount(viewer: ViewerContext): boolean {
  return viewer.status === "active";
}

function isCategoryModerator(
  viewer: ViewerContext,
  categoryId: string,
): boolean {
  return (
    viewer.role === "moderator" &&
    hasActiveRole(viewer) &&
    viewer.moderatedCategoryIds.has(categoryId)
  );
}

function grantMatches(viewer: ViewerContext, grant: CategoryGrant): boolean {
  if (grant.principal === "everyone") return true;
  if (grant.principal === "authenticated") return isReadableAccount(viewer);
  return (
    isReadableAccount(viewer) &&
    grant.principalId !== undefined &&
    viewer.groupIds.has(grant.principalId)
  );
}

function aclAllows(
  viewer: ViewerContext,
  category: CategoryPolicy,
  action: CategoryAction,
): boolean {
  if (category.aclMode === "open") {
    return action === "see" || isAuthenticated(viewer);
  }
  return category.grants.some(
    (grant) => grant.permission === action && grantMatches(viewer, grant),
  );
}

function viewingLevel(viewer: ViewerContext): TrustLevel {
  // The product decision treats guests as level 0 for read checks only.
  return isReadableAccount(viewer) ? (viewer.trustLevel ?? 0) : 0;
}

export function evaluateViewCategory(
  viewer: ViewerContext,
  category: CategoryPolicy,
): PermissionDecision {
  if (viewer.role === "admin" && hasActiveRole(viewer)) return allow("admin");
  if (category.state === "deleted") return deny("category_unavailable");
  const levelAllowed = viewingLevel(viewer) >= category.minViewLevel;
  const aclAllowed = aclAllows(viewer, category, "see");
  if (levelAllowed && aclAllowed) return allow();
  if (isCategoryModerator(viewer, category.id)) {
    return allow("category_moderator");
  }
  if (!aclAllowed) return deny("group_acl_denied");
  return deny("level_too_low");
}

export function canViewCategory(
  viewer: ViewerContext,
  category: CategoryPolicy,
): boolean {
  return evaluateViewCategory(viewer, category).allowed;
}

export function evaluateCreateTopic(
  viewer: ViewerContext,
  category: CategoryPolicy,
  requestedMinLevel: TrustLevel,
): PermissionDecision {
  if (viewer.role === "admin" && hasActiveRole(viewer)) {
    return category.state !== "deleted" &&
      requestedMinLevel <= category.allowedTopicMinLevelMax
      ? allow("admin")
      : deny("requested_level_invalid");
  }
  if (!isAuthenticated(viewer)) return deny("authentication_required");
  if (!isWritableAccount(viewer)) return deny("account_inactive");
  if (category.state !== "active") return deny("category_unavailable");
  const categoryView = evaluateViewCategory(viewer, category);
  if (!categoryView.allowed || categoryView.reason === "category_moderator") {
    return categoryView.allowed
      ? deny("group_acl_denied")
      : categoryView;
  }
  if ((viewer.trustLevel ?? 0) < category.minCreateLevel) {
    return deny("level_too_low");
  }
  if (!aclAllows(viewer, category, "create")) {
    return deny("group_acl_denied");
  }
  if (
    requestedMinLevel > (viewer.trustLevel ?? 0) ||
    requestedMinLevel > category.allowedTopicMinLevelMax
  ) {
    return deny("requested_level_invalid");
  }
  return allow();
}

export function canCreateTopic(
  viewer: ViewerContext,
  category: CategoryPolicy,
  requestedMinLevel: TrustLevel,
): boolean {
  return evaluateCreateTopic(viewer, category, requestedMinLevel).allowed;
}

export function evaluateViewTopic(
  viewer: ViewerContext,
  category: CategoryPolicy,
  topic: TopicPolicy,
): PermissionDecision {
  if (viewer.role === "admin" && hasActiveRole(viewer)) return allow("admin");
  if (topic.categoryId !== category.id || topic.state === "deleted") {
    return deny("topic_unavailable");
  }
  const moderator = isCategoryModerator(viewer, category.id);
  if (
    topic.state === "pending" &&
    viewer.userId !== topic.authorId &&
    !moderator
  ) return deny("topic_unavailable");
  const aclPermitsView = aclAllows(viewer, category, "see");
  const levelPermitsCategory = viewingLevel(viewer) >= category.minViewLevel;
  const safeEffectiveLevel = Math.max(
    category.minViewLevel,
    topic.minViewLevel,
    topic.effectiveMinViewLevel,
  ) as TrustLevel;
  const levelPermitsTopic = viewingLevel(viewer) >= safeEffectiveLevel;

  if (aclPermitsView && levelPermitsCategory && levelPermitsTopic) {
    return allow();
  }

  if (moderator) return allow("category_moderator");

  // A demoted author keeps direct, read-only access. This bypasses only the
  // trust-level check: removing the author from an allowed group still revokes
  // access, and no list/search endpoint should surface the topic through this
  // exception.
  if (
    viewer.userId === topic.authorId &&
    viewer.status === "active" &&
    aclPermitsView &&
    viewingLevel(viewer) < safeEffectiveLevel &&
    safeEffectiveLevel <= topic.authorQualifiedVisibilityLevel
  ) {
    return allow("author_read_only", true);
  }

  if (!aclPermitsView) return deny("group_acl_denied");
  return deny("level_too_low");
}

export function canViewTopic(
  viewer: ViewerContext,
  category: CategoryPolicy,
  topic: TopicPolicy,
): boolean {
  return evaluateViewTopic(viewer, category, topic).allowed;
}

export function evaluateReplyTopic(
  viewer: ViewerContext,
  category: CategoryPolicy,
  topic: TopicPolicy,
): PermissionDecision {
  if (viewer.role === "admin" && hasActiveRole(viewer)) {
    if (topic.state === "deleted") return deny("topic_unavailable");
    if (
      topic.state !== "open" ||
      topic.authorDowngradeLocked
    ) {
      return deny("topic_read_only");
    }
    return allow("admin");
  }
  if (!isAuthenticated(viewer)) return deny("authentication_required");
  if (!isWritableAccount(viewer)) return deny("account_inactive");
  if (category.state !== "active") return deny("category_unavailable");
  if (topic.state !== "open" || topic.authorDowngradeLocked) {
    return deny("topic_read_only");
  }

  const view = evaluateViewTopic(viewer, category, topic);
  if (!view.allowed) return view;
  if (view.readOnly || view.reason === "category_moderator") {
    return deny("topic_read_only");
  }
  if ((viewer.trustLevel ?? 0) < category.minReplyLevel) {
    return deny("level_too_low");
  }
  const safeEffectiveLevel = Math.max(
    category.minViewLevel,
    topic.minViewLevel,
    topic.effectiveMinViewLevel,
  );
  if ((viewer.trustLevel ?? 0) < safeEffectiveLevel) {
    return deny("level_too_low");
  }
  if (!aclAllows(viewer, category, "reply")) {
    return deny("group_acl_denied");
  }
  return allow();
}

export function canReplyTopic(
  viewer: ViewerContext,
  category: CategoryPolicy,
  topic: TopicPolicy,
): boolean {
  return evaluateReplyTopic(viewer, category, topic).allowed;
}

export function evaluateModerate(
  viewer: ViewerContext,
  categoryId: string,
): PermissionDecision {
  if (viewer.role === "admin" && hasActiveRole(viewer)) return allow("admin");
  if (isCategoryModerator(viewer, categoryId) && isWritableAccount(viewer)) {
    return allow("category_moderator");
  }
  return deny("moderator_scope_denied");
}

export function canModerate(
  viewer: ViewerContext,
  categoryId: string,
): boolean {
  return evaluateModerate(viewer, categoryId).allowed;
}

export function evaluateAccessUpload(
  viewer: ViewerContext,
  category: CategoryPolicy | null,
  upload: UploadPolicy,
): PermissionDecision {
  if (viewer.role === "admin" && hasActiveRole(viewer)) return allow("admin");
  if (upload.state === "deleted" || upload.state === "quarantined") {
    return deny("upload_unavailable");
  }
  if (upload.topic) {
    if (!category || upload.state !== "bound") {
      return deny("upload_unavailable");
    }
    return evaluateViewTopic(viewer, category, upload.topic);
  }
  if (
    isAuthenticated(viewer) &&
    viewer.status === "active" &&
    viewer.userId === upload.ownerUserId
  ) {
    return allow();
  }
  return deny("not_owner");
}

export function canAccessUpload(
  viewer: ViewerContext,
  category: CategoryPolicy | null,
  upload: UploadPolicy,
): boolean {
  return evaluateAccessUpload(viewer, category, upload).allowed;
}

export const permissionInternals = {
  aclAllows,
};
