import { describe, expect, it } from "vitest";
import type {
  CategoryPolicy,
  TopicPolicy,
  ViewerContext,
} from "@/worker/permissions/policy";
import {
  canCreateTopic,
  canModerate,
  canReplyTopic,
  canViewCategory,
  evaluateViewTopic,
} from "@/worker/permissions/policy";

const empty = new Set<string>();

function viewer(
  overrides: Partial<ViewerContext> = {},
): ViewerContext {
  return {
    userId: "user-1",
    role: "member",
    status: "active",
    trustLevel: 1,
    groupIds: empty,
    moderatedCategoryIds: empty,
    ...overrides,
  };
}

const publicCategory: CategoryPolicy = {
  id: "general",
  state: "active",
  aclMode: "open",
  minViewLevel: 0,
  minReplyLevel: 1,
  minCreateLevel: 1,
  allowedTopicMinLevelMax: 3,
  grants: [],
};

const levelThreeTopic: TopicPolicy = {
  id: "topic-3",
  categoryId: "general",
  authorId: "author-3",
  minViewLevel: 3,
  effectiveMinViewLevel: 3,
  state: "open",
  authorQualifiedVisibilityLevel: 3,
  authorDowngradeLocked: false,
};

describe("central permission policy", () => {
  it("allows guests to see level-zero categories and topics only", () => {
    const guest = viewer({
      userId: null,
      role: "guest",
      status: "guest",
      trustLevel: null,
    });
    expect(canViewCategory(guest, publicCategory)).toBe(true);
    expect(
      evaluateViewTopic(guest, publicCategory, {
        ...levelThreeTopic,
        minViewLevel: 0,
        effectiveMinViewLevel: 0,
      }).allowed,
    ).toBe(true);
    expect(evaluateViewTopic(guest, publicCategory, levelThreeTopic)).toMatchObject(
      { allowed: false, reason: "level_too_low", concealExistence: true },
    );
  });

  it("requires both trust level and a matching group ACL", () => {
    const privateCategory: CategoryPolicy = {
      ...publicCategory,
      aclMode: "restricted",
      minViewLevel: 2,
      grants: [
        { principal: "group", principalId: "builders", permission: "see" },
      ],
    };
    expect(canViewCategory(viewer({ trustLevel: 3 }), privateCategory)).toBe(
      false,
    );
    expect(
      canViewCategory(
        viewer({ trustLevel: 1, groupIds: new Set(["builders"]) }),
        privateCategory,
      ),
    ).toBe(false);
    expect(
      canViewCategory(
        viewer({ trustLevel: 3, groupIds: new Set(["builders"]) }),
        privateCategory,
      ),
    ).toBe(true);
  });

  it("keeps a demoted author's topic access read-only", () => {
    const author = viewer({ userId: "author-3", trustLevel: 2 });
    expect(evaluateViewTopic(author, publicCategory, levelThreeTopic)).toMatchObject(
      { allowed: true, reason: "author_read_only", readOnly: true },
    );
    expect(canReplyTopic(author, publicCategory, levelThreeTopic)).toBe(false);
  });

  it("does not let the author exception bypass a group ACL", () => {
    const privateCategory: CategoryPolicy = {
      ...publicCategory,
      aclMode: "restricted",
      grants: [
        { principal: "group", principalId: "builders", permission: "see" },
      ],
    };
    const removedAuthor = viewer({ userId: "author-3", trustLevel: 2 });
    expect(
      evaluateViewTopic(removedAuthor, privateCategory, levelThreeTopic),
    ).toMatchObject({ allowed: false, reason: "group_acl_denied" });
  });

  it("scopes moderators to assigned categories", () => {
    const scoped = viewer({
      role: "moderator",
      moderatedCategoryIds: new Set(["general"]),
    });
    expect(canModerate(scoped, "general")).toBe(true);
    expect(canModerate(scoped, "staff-only")).toBe(false);
    expect(evaluateViewTopic(scoped, publicCategory, levelThreeTopic)).toMatchObject(
      { allowed: true, reason: "category_moderator" },
    );
  });

  it("prevents users from publishing above their level or category cap", () => {
    expect(canCreateTopic(viewer({ trustLevel: 2 }), publicCategory, 2)).toBe(
      true,
    );
    expect(canCreateTopic(viewer({ trustLevel: 2 }), publicCategory, 3)).toBe(
      false,
    );
    expect(
      canCreateTopic(
        viewer({ trustLevel: 4 }),
        { ...publicCategory, allowedTopicMinLevelMax: 2 },
        3,
      ),
    ).toBe(false);
  });

  it("treats locked, archived and pending topics as non-replyable", () => {
    for (const state of ["locked", "archived", "pending"] as const) {
      expect(
        canReplyTopic(
          viewer({ trustLevel: 3 }),
          publicCategory,
          { ...levelThreeTopic, state },
        ),
      ).toBe(false);
    }
  });

  it("locks a demoted author's topic for every participant", () => {
    const lockedByDemotion: TopicPolicy = {
      ...levelThreeTopic,
      authorDowngradeLocked: true,
    };
    expect(
      canReplyTopic(
        viewer({ userId: "level-4", trustLevel: 4 }),
        publicCategory,
        lockedByDemotion,
      ),
    ).toBe(false);
  });

  it("lets administrators bypass visibility but not invalid topic levels", () => {
    const admin = viewer({ role: "admin", trustLevel: 4 });
    const deleted = { ...publicCategory, state: "deleted" as const };
    expect(canViewCategory(admin, deleted)).toBe(true);
    expect(canCreateTopic(admin, publicCategory, 4)).toBe(false);
  });
});
