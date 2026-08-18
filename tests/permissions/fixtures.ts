import type { TrustLevel } from "@/shared/domain";
import type {
  CategoryPolicy,
  TopicPolicy,
  UploadPolicy,
  ViewerContext,
} from "@/worker/permissions/policy";

export const asTrustLevel = (value: number): TrustLevel => value as TrustLevel;

export function makeViewer(
  overrides: Partial<ViewerContext> = {},
): ViewerContext {
  return {
    userId: "member-1",
    role: "member",
    status: "active",
    trustLevel: 1,
    groupIds: new Set<string>(),
    moderatedCategoryIds: new Set<string>(),
    ...overrides,
  };
}

export function makeGuest(): ViewerContext {
  return makeViewer({
    userId: null,
    role: "guest",
    status: "guest",
    trustLevel: null,
  });
}

export function makeCategory(
  overrides: Partial<CategoryPolicy> = {},
): CategoryPolicy {
  return {
    id: "category-1",
    state: "active",
    aclMode: "open",
    minViewLevel: 0,
    minReplyLevel: 0,
    minCreateLevel: 0,
    allowedTopicMinLevelMax: 4,
    grants: [],
    ...overrides,
  };
}

export function makeTopic(
  overrides: Partial<TopicPolicy> = {},
): TopicPolicy {
  return {
    id: "topic-1",
    categoryId: "category-1",
    authorId: "author-1",
    minViewLevel: 0,
    effectiveMinViewLevel: 0,
    state: "open",
    authorQualifiedVisibilityLevel: 0,
    authorDowngradeLocked: false,
    ...overrides,
  };
}

export function makeUpload(
  overrides: Partial<UploadPolicy> = {},
): UploadPolicy {
  return {
    id: "upload-1",
    ownerUserId: "author-1",
    topic: null,
    state: "bound",
    ...overrides,
  };
}
