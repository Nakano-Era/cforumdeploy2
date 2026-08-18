import { TRUST_LEVELS, type TrustLevel } from "@/shared/domain";
import {
  canAccessUpload,
  canCreateTopic,
  canReplyTopic,
  canViewCategory,
  canViewTopic,
} from "@/worker/permissions/policy";
import { describe, expect, it } from "vitest";
import {
  asTrustLevel,
  makeCategory,
  makeGuest,
  makeTopic,
  makeUpload,
  makeViewer,
} from "./fixtures";

const GROUP_ID = "matrix-group";

const viewActors = [
  {
    name: "guest",
    readLevel: 0 as TrustLevel,
    viewer: makeGuest(),
  },
  ...TRUST_LEVELS.map((level) => ({
    name: `lv${level}`,
    readLevel: level,
    viewer: makeViewer({
      userId: `level-${level}`,
      trustLevel: level,
    }),
  })),
];

const viewCases = viewActors.flatMap((actor) =>
  TRUST_LEVELS.flatMap((categoryMin) =>
    TRUST_LEVELS.flatMap((topicMin) =>
      [false, true].map((hasSeeGrant) => {
        const effectiveMin = asTrustLevel(Math.max(categoryMin, topicMin));
        return {
          name: `${actor.name} category=${categoryMin} topic=${topicMin} see=${hasSeeGrant}`,
          viewer: actor.viewer,
          category: makeCategory({
            aclMode: "restricted",
            minViewLevel: categoryMin,
            grants: hasSeeGrant
              ? [{ principal: "everyone", permission: "see" }]
              : [],
          }),
          topic: makeTopic({
            effectiveMinViewLevel: effectiveMin,
            authorQualifiedVisibilityLevel: effectiveMin,
          }),
          expected:
            hasSeeGrant && actor.readLevel >= effectiveMin,
        };
      }),
    ),
  ),
);

interface AclCombination {
  name: string;
  see: boolean;
  action: boolean;
}

const aclCombinations: readonly AclCombination[] = [
  { name: "none", see: false, action: false },
  { name: "see-only", see: true, action: false },
  { name: "action-only", see: false, action: true },
  { name: "see-and-action", see: true, action: true },
];

const createCases = TRUST_LEVELS.flatMap((actorLevel) =>
  TRUST_LEVELS.flatMap((categoryMinView) =>
    TRUST_LEVELS.flatMap((categoryMinCreate) =>
      TRUST_LEVELS.flatMap((requestedMin) =>
        aclCombinations.map((acl) => ({
          name: `lv${actorLevel} view=${categoryMinView} create=${categoryMinCreate} requested=${requestedMin} acl=${acl.name}`,
          viewer: makeViewer({
            trustLevel: actorLevel,
            groupIds: new Set([GROUP_ID]),
          }),
          category: makeCategory({
            aclMode: "restricted",
            minViewLevel: categoryMinView,
            minCreateLevel: categoryMinCreate,
            allowedTopicMinLevelMax: 4,
            grants: [
              ...(acl.see
                ? [
                    {
                      principal: "group" as const,
                      principalId: GROUP_ID,
                      permission: "see" as const,
                    },
                  ]
                : []),
              ...(acl.action
                ? [
                    {
                      principal: "group" as const,
                      principalId: GROUP_ID,
                      permission: "create" as const,
                    },
                  ]
                : []),
            ],
          }),
          requestedMin,
          expected:
            acl.see &&
            acl.action &&
            actorLevel >= categoryMinView &&
            actorLevel >= categoryMinCreate &&
            requestedMin <= actorLevel,
        })),
      ),
    ),
  ),
);

const createCapCases = TRUST_LEVELS.flatMap((actorLevel) =>
  TRUST_LEVELS.flatMap((requestedMin) =>
    TRUST_LEVELS.map((allowedMax) => ({
      name: `lv${actorLevel} requested=${requestedMin} cap=${allowedMax}`,
      viewer: makeViewer({ trustLevel: actorLevel }),
      category: makeCategory({ allowedTopicMinLevelMax: allowedMax }),
      requestedMin,
      expected: requestedMin <= actorLevel && requestedMin <= allowedMax,
    })),
  ),
);

const replyCases = TRUST_LEVELS.flatMap((actorLevel) =>
  TRUST_LEVELS.flatMap((categoryMinView) =>
    TRUST_LEVELS.flatMap((topicMinView) =>
      TRUST_LEVELS.flatMap((categoryMinReply) =>
        aclCombinations.flatMap((acl) =>
          [false, true].map((locked) => {
            const effectiveMin = asTrustLevel(
              Math.max(categoryMinView, topicMinView),
            );
            return {
              name: `lv${actorLevel} view=${categoryMinView} topic=${topicMinView} reply=${categoryMinReply} acl=${acl.name} locked=${locked}`,
              viewer: makeViewer({
                trustLevel: actorLevel,
                groupIds: new Set([GROUP_ID]),
              }),
              category: makeCategory({
                aclMode: "restricted",
                minViewLevel: categoryMinView,
                minReplyLevel: categoryMinReply,
                grants: [
                  ...(acl.see
                    ? [
                        {
                          principal: "group" as const,
                          principalId: GROUP_ID,
                          permission: "see" as const,
                        },
                      ]
                    : []),
                  ...(acl.action
                    ? [
                        {
                          principal: "group" as const,
                          principalId: GROUP_ID,
                          permission: "reply" as const,
                        },
                      ]
                    : []),
                ],
              }),
              topic: makeTopic({
                effectiveMinViewLevel: effectiveMin,
                authorQualifiedVisibilityLevel: effectiveMin,
                authorDowngradeLocked: locked,
              }),
              expected:
                !locked &&
                acl.see &&
                acl.action &&
                actorLevel >= effectiveMin &&
                actorLevel >= categoryMinReply,
            };
          }),
        ),
      ),
    ),
  ),
);

describe("permission threshold and ACL matrices", () => {
  it("contains exactly 300 guest/Lv0-Lv4 view combinations", () => {
    expect(viewCases).toHaveLength(300);
  });

  it.each(viewCases)("view: $name", ({ viewer, category, topic, expected }) => {
    expect(canViewCategory(viewer, category)).toBe(
      expected ||
        (category.minViewLevel <= (viewer.trustLevel ?? 0) &&
          category.grants.length > 0),
    );
    expect(canViewTopic(viewer, category, topic)).toBe(expected);

    const inheritedUpload = makeUpload({ topic });
    expect(canAccessUpload(viewer, category, inheritedUpload)).toBe(expected);
  });

  it("contains the complete level/view/create/requested/ACL creation matrix", () => {
    expect(createCases).toHaveLength(2_500);
  });

  it.each(createCases)(
    "create: $name",
    ({ viewer, category, requestedMin, expected }) => {
      expect(canCreateTopic(viewer, category, requestedMin)).toBe(expected);
    },
  );

  it.each(createCapCases)(
    "create cap: $name",
    ({ viewer, category, requestedMin, expected }) => {
      expect(canCreateTopic(viewer, category, requestedMin)).toBe(expected);
    },
  );

  it("contains the complete level/view/topic/reply/ACL/lock reply matrix", () => {
    expect(replyCases).toHaveLength(5_000);
  });

  it.each(replyCases)(
    "reply: $name",
    ({ viewer, category, topic, expected }) => {
      expect(canReplyTopic(viewer, category, topic)).toBe(expected);
    },
  );
});
