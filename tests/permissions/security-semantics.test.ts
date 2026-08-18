import type { UserRole, UserStatus } from "@/shared/domain";
import {
  canAccessUpload,
  canCreateTopic,
  canModerate,
  canReplyTopic,
  evaluateAccessUpload,
  evaluateCreateTopic,
  evaluateReplyTopic,
  evaluateViewTopic,
  permissionInternals,
} from "@/worker/permissions/policy";
import { describe, expect, it } from "vitest";
import {
  makeCategory,
  makeGuest,
  makeTopic,
  makeUpload,
  makeViewer,
} from "./fixtures";

const GROUP_ID = "builders";

const allActionCategory = makeCategory({
  aclMode: "restricted",
  grants: [
    { principal: "group", principalId: GROUP_ID, permission: "see" },
    { principal: "group", principalId: GROUP_ID, permission: "reply" },
    { principal: "group", principalId: GROUP_ID, permission: "create" },
  ],
});

describe("independent see/reply/create ACL capabilities", () => {
  const actor = makeViewer({
    trustLevel: 3,
    groupIds: new Set([GROUP_ID]),
  });
  const topic = makeTopic();

  it("does not let a create grant imply see or reply", () => {
    const category = makeCategory({
      aclMode: "restricted",
      grants: [
        { principal: "group", principalId: GROUP_ID, permission: "create" },
      ],
    });

    expect(permissionInternals.aclAllows(actor, category, "see")).toBe(false);
    expect(permissionInternals.aclAllows(actor, category, "reply")).toBe(false);
    expect(permissionInternals.aclAllows(actor, category, "create")).toBe(true);
    expect(canCreateTopic(actor, category, 0)).toBe(false);
    expect(canReplyTopic(actor, category, topic)).toBe(false);
  });

  it("does not let a reply grant imply see or create", () => {
    const category = makeCategory({
      aclMode: "restricted",
      grants: [
        { principal: "group", principalId: GROUP_ID, permission: "reply" },
      ],
    });

    expect(permissionInternals.aclAllows(actor, category, "see")).toBe(false);
    expect(permissionInternals.aclAllows(actor, category, "reply")).toBe(true);
    expect(permissionInternals.aclAllows(actor, category, "create")).toBe(false);
    expect(canCreateTopic(actor, category, 0)).toBe(false);
    expect(canReplyTopic(actor, category, topic)).toBe(false);
  });

  it("allows create but not reply with independent see+create grants", () => {
    const category = makeCategory({
      aclMode: "restricted",
      grants: [
        { principal: "group", principalId: GROUP_ID, permission: "see" },
        { principal: "group", principalId: GROUP_ID, permission: "create" },
      ],
    });

    expect(canCreateTopic(actor, category, 0)).toBe(true);
    expect(canReplyTopic(actor, category, topic)).toBe(false);
  });

  it("allows reply but not create with independent see+reply grants", () => {
    const category = makeCategory({
      aclMode: "restricted",
      grants: [
        { principal: "group", principalId: GROUP_ID, permission: "see" },
        { principal: "group", principalId: GROUP_ID, permission: "reply" },
      ],
    });

    expect(canReplyTopic(actor, category, topic)).toBe(true);
    expect(canCreateTopic(actor, category, 0)).toBe(false);
  });

  it("never treats a restricted ACL with no grants as open", () => {
    const category = makeCategory({ aclMode: "restricted", grants: [] });
    expect(evaluateViewTopic(actor, category, topic)).toMatchObject({
      allowed: false,
      reason: "group_acl_denied",
      concealExistence: true,
    });
  });

  it("requires authentication even if everyone is granted create and reply", () => {
    const category = makeCategory({
      aclMode: "restricted",
      grants: [
        { principal: "everyone", permission: "see" },
        { principal: "everyone", permission: "reply" },
        { principal: "everyone", permission: "create" },
      ],
    });
    const guest = makeGuest();

    expect(evaluateCreateTopic(guest, category, 0)).toMatchObject({
      allowed: false,
      reason: "authentication_required",
    });
    expect(evaluateReplyTopic(guest, category, topic)).toMatchObject({
      allowed: false,
      reason: "authentication_required",
    });
  });
});

describe("inactive accounts never inherit admin or moderator bypass", () => {
  const nonActiveStatuses = [
    "pending",
    "silenced",
    "suspended",
    "deleted",
  ] as const satisfies readonly UserStatus[];

  for (const role of ["admin", "moderator"] as const satisfies readonly UserRole[]) {
    for (const status of nonActiveStatuses) {
      it(`${status} ${role} cannot write, moderate, or access an unbound owner upload`, () => {
        const actor = makeViewer({
          role,
          status,
          trustLevel: 4,
          moderatedCategoryIds: new Set(["category-1"]),
        });
        const category = makeCategory();
        const topic = makeTopic();
        const ownerUpload = makeUpload({
          ownerUserId: actor.userId ?? "missing",
          topic: null,
          state: "uploaded",
        });

        expect(canCreateTopic(actor, category, 0)).toBe(false);
        expect(canReplyTopic(actor, category, topic)).toBe(false);
        expect(canModerate(actor, category.id)).toBe(false);
        expect(canAccessUpload(actor, null, ownerUpload)).toBe(false);
      });
    }
  }

  for (const status of ["pending", "suspended", "deleted"] as const) {
    it(`${status} admin cannot use its role to read a high-level category`, () => {
      const actor = makeViewer({ role: "admin", status, trustLevel: 4 });
      const category = makeCategory({ minViewLevel: 4 });
      const topic = makeTopic({
        effectiveMinViewLevel: 4,
        authorQualifiedVisibilityLevel: 4,
      });

      expect(evaluateViewTopic(actor, category, topic)).toMatchObject({
        allowed: false,
        concealExistence: true,
      });
    });
  }

  it("a silenced admin may read only through ordinary member rules", () => {
    const actor = makeViewer({ role: "admin", status: "silenced", trustLevel: 4 });
    const category = makeCategory({ minViewLevel: 4 });
    const topic = makeTopic({
      effectiveMinViewLevel: 4,
      authorQualifiedVisibilityLevel: 4,
    });

    expect(evaluateViewTopic(actor, category, topic)).toMatchObject({
      allowed: true,
      reason: "allowed",
    });
  });
});

describe("author downgrade produces read-only access and a global reply lock", () => {
  const category = makeCategory({
    minViewLevel: 3,
    minReplyLevel: 3,
  });
  const demotedTopic = makeTopic({
    authorId: "demoted-author",
    effectiveMinViewLevel: 3,
    authorQualifiedVisibilityLevel: 3,
    authorDowngradeLocked: true,
  });

  it("allows only the active author through the read-only exception", () => {
    const author = makeViewer({
      userId: "demoted-author",
      trustLevel: 2,
    });

    expect(evaluateViewTopic(author, category, demotedTopic)).toMatchObject({
      allowed: true,
      reason: "author_read_only",
      readOnly: true,
    });
    expect(canReplyTopic(author, category, demotedTopic)).toBe(false);
  });

  it.each(["pending", "silenced", "suspended", "deleted"] as const)(
    "does not grant the author exception to a %s account",
    (status) => {
      const author = makeViewer({
        userId: "demoted-author",
        status,
        trustLevel: 2,
      });
      expect(evaluateViewTopic(author, category, demotedTopic).allowed).toBe(
        false,
      );
    },
  );

  it("does not let the exception bypass a removed group ACL", () => {
    const restricted = makeCategory({
      minViewLevel: 3,
      aclMode: "restricted",
      grants: [
        { principal: "group", principalId: GROUP_ID, permission: "see" },
      ],
    });
    const author = makeViewer({
      userId: "demoted-author",
      trustLevel: 2,
      groupIds: new Set(),
    });

    expect(evaluateViewTopic(author, restricted, demotedTopic)).toMatchObject({
      allowed: false,
      reason: "group_acl_denied",
    });
  });

  it("does not grant an exception above the author's qualified visibility", () => {
    const author = makeViewer({
      userId: "demoted-author",
      trustLevel: 2,
    });
    const raisedLater = {
      ...demotedTopic,
      effectiveMinViewLevel: 4 as const,
      authorQualifiedVisibilityLevel: 3 as const,
    };

    expect(evaluateViewTopic(author, category, raisedLater).allowed).toBe(false);
  });

  it.each([
    { name: "lv3 member", actor: makeViewer({ trustLevel: 3 }) },
    { name: "lv4 member", actor: makeViewer({ trustLevel: 4 }) },
    {
      name: "assigned moderator",
      actor: makeViewer({
        role: "moderator",
        trustLevel: 4,
        moderatedCategoryIds: new Set(["category-1"]),
      }),
    },
    { name: "admin", actor: makeViewer({ role: "admin", trustLevel: 4 }) },
  ])("blocks replies globally for $name", ({ actor }) => {
    expect(canReplyTopic(actor, category, demotedTopic)).toBe(false);
  });

  it("keeps an independent manual lock after the downgrade lock clears", () => {
    const recoveredTopic = {
      ...demotedTopic,
      state: "locked" as const,
      authorDowngradeLocked: false,
    };
    expect(
      canReplyTopic(
        makeViewer({ userId: "demoted-author", trustLevel: 3 }),
        category,
        recoveredTopic,
      ),
    ).toBe(false);
  });
});

describe("uploads inherit their bound topic visibility", () => {
  const category = makeCategory({
    aclMode: "restricted",
    minViewLevel: 3,
    grants: [
      { principal: "group", principalId: GROUP_ID, permission: "see" },
    ],
  });
  const topic = makeTopic({
    effectiveMinViewLevel: 3,
    authorQualifiedVisibilityLevel: 3,
  });
  const upload = makeUpload({ topic, ownerUserId: "upload-owner" });

  it("allows and rejects the same ordinary actors as the parent topic", () => {
    const actors = [
      makeGuest(),
      makeViewer({ userId: "upload-owner", trustLevel: 4 }),
      makeViewer({ trustLevel: 2, groupIds: new Set([GROUP_ID]) }),
      makeViewer({ trustLevel: 3, groupIds: new Set([GROUP_ID]) }),
      makeViewer({ trustLevel: 4, groupIds: new Set([GROUP_ID]) }),
    ];

    for (const actor of actors) {
      expect(canAccessUpload(actor, category, upload)).toBe(
        evaluateViewTopic(actor, category, topic).allowed,
      );
    }
  });

  it("does not let ownership bypass the parent topic", () => {
    const ownerWithoutGroup = makeViewer({
      userId: "upload-owner",
      trustLevel: 4,
    });
    expect(evaluateAccessUpload(ownerWithoutGroup, category, upload)).toMatchObject(
      {
        allowed: false,
        reason: "group_acl_denied",
        concealExistence: true,
      },
    );
  });

  it("fails closed when an attached upload is missing its category aggregate", () => {
    const owner = makeViewer({
      userId: "upload-owner",
      trustLevel: 4,
      groupIds: new Set([GROUP_ID]),
    });
    expect(canAccessUpload(owner, null, upload)).toBe(false);
  });

  it("fails closed when the supplied category does not own the topic", () => {
    const actor = makeViewer({
      trustLevel: 4,
      groupIds: new Set([GROUP_ID]),
    });
    expect(
      canAccessUpload(actor, { ...category, id: "different-category" }, upload),
    ).toBe(false);
  });

  it.each(["quarantined", "deleted"] as const)(
    "does not serve a %s upload to an ordinary authorized viewer",
    (state) => {
      const actor = makeViewer({
        trustLevel: 4,
        groupIds: new Set([GROUP_ID]),
      });
      expect(canAccessUpload(actor, category, { ...upload, state })).toBe(false);
    },
  );

  it("serves inherited media through the author's downgrade read exception", () => {
    const demotedAuthor = makeViewer({
      userId: topic.authorId,
      trustLevel: 2,
      groupIds: new Set([GROUP_ID]),
    });
    expect(evaluateAccessUpload(demotedAuthor, category, upload)).toMatchObject({
      allowed: true,
      reason: "author_read_only",
      readOnly: true,
    });
  });
});

describe("category moderator scope", () => {
  const hiddenCategory = makeCategory({
    aclMode: "restricted",
    minViewLevel: 4,
    grants: [],
  });
  const hiddenTopic = makeTopic({
    effectiveMinViewLevel: 4,
    authorQualifiedVisibilityLevel: 4,
  });

  it("allows read and moderation only in explicitly assigned categories", () => {
    const moderator = makeViewer({
      role: "moderator",
      trustLevel: 0,
      moderatedCategoryIds: new Set(["category-1"]),
    });

    expect(evaluateViewTopic(moderator, hiddenCategory, hiddenTopic)).toMatchObject(
      { allowed: true, reason: "category_moderator" },
    );
    expect(canModerate(moderator, "category-1")).toBe(true);
    expect(canModerate(moderator, "category-2")).toBe(false);

    const otherCategory = { ...hiddenCategory, id: "category-2" };
    const otherTopic = { ...hiddenTopic, categoryId: "category-2" };
    expect(evaluateViewTopic(moderator, otherCategory, otherTopic).allowed).toBe(
      false,
    );
  });

  it("does not make a scoped moderator's ordinary posting permission disappear", () => {
    const moderator = makeViewer({
      role: "moderator",
      trustLevel: 3,
      groupIds: new Set([GROUP_ID]),
      moderatedCategoryIds: new Set(["category-1"]),
    });
    const topic = makeTopic();

    expect(canCreateTopic(moderator, allActionCategory, 3)).toBe(true);
    expect(canReplyTopic(moderator, allActionCategory, topic)).toBe(true);
  });

  it("does not let moderation scope grant ordinary posting permission", () => {
    const moderator = makeViewer({
      role: "moderator",
      trustLevel: 0,
      groupIds: new Set(),
      moderatedCategoryIds: new Set(["category-1"]),
    });

    expect(canCreateTopic(moderator, allActionCategory, 0)).toBe(false);
    expect(canReplyTopic(moderator, allActionCategory, makeTopic())).toBe(false);
  });

  it("lets an assigned moderator access bound media but not an out-of-scope moderator", () => {
    const topic = makeTopic({
      effectiveMinViewLevel: 4,
      authorQualifiedVisibilityLevel: 4,
    });
    const upload = makeUpload({ topic });
    const assigned = makeViewer({
      role: "moderator",
      trustLevel: 0,
      moderatedCategoryIds: new Set(["category-1"]),
    });
    const unassigned = makeViewer({
      role: "moderator",
      trustLevel: 0,
      moderatedCategoryIds: new Set(["category-2"]),
    });

    expect(canAccessUpload(assigned, hiddenCategory, upload)).toBe(true);
    expect(canAccessUpload(unassigned, hiddenCategory, upload)).toBe(false);
  });
});
