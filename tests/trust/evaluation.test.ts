import { describe, expect, it } from "vitest";
import {
  CONFIRMED_REPORT_TIME_SQL,
  evaluateTrustLevel,
  meetsLevelOne,
  meetsLevelThree,
  trustMetricDenominatorScope,
  type TrustMetrics,
} from "@/worker/trust/engine";
import type { TrustRules } from "@/worker/trust/schemas";

const DAY = 24 * 60 * 60;
const NOW = 2_000_000_000;

const rules: TrustRules = {
  1: { topicsEntered: 5, postsRead: 30, readingSeconds: 600 },
  2: {
    topicsEntered: 20,
    postsRead: 100,
    readingSeconds: 3_600,
    visitDays: 15,
    distinctTopicsReplied: 3,
    likesGiven: 1,
    likesReceived: 1,
    demoteAfterInactiveDays: 90,
    warningDays: 14,
  },
  3: {
    windowDays: 100,
    topicPercent: 25,
    topicCap: 500,
    postPercent: 25,
    postCap: 20_000,
    distinctTopicsReplied: 10,
    readingDays: 50,
    likesGiven: 30,
    likesReceived: 20,
    likeGiverCount: 5,
    likeDayCount: 7,
    maxConfirmedSevereReports: 0,
    sanctionFreeDays: 180,
    graceDays: 14,
    demotionRatio: 0.9,
  },
  4: { manualOnly: true },
};

function metrics(overrides: Partial<TrustMetrics> = {}): TrustMetrics {
  const base: TrustMetrics = {
    asOfDate: "2033-05-18",
    windowStartDate: "2033-02-08",
    lifetime: {
      topicsEntered: 100,
      postsRead: 1_000,
      readingSeconds: 20_000,
      visitDays: 100,
      distinctTopicsReplied: 20,
      likesGiven: 100,
      likesReceived: 100,
    },
    window: {
      windowDays: 100,
      topicsEntered: 100,
      postsRead: 1_000,
      readingSeconds: 10_000,
      readingDays: 60,
      distinctTopicsReplied: 20,
      likesGiven: 50,
      likesReceived: 40,
      likeGiverCount: 10,
      likeDayCount: 10,
      newTopics: 400,
      newPosts: 4_000,
      confirmedSevereReports: 0,
      recentSanctions: 0,
    },
    lastQualifyingActivityAt: NOW - DAY,
    firstPromotedToLevelThreeAt: NOW - 30 * DAY,
  };
  return {
    ...base,
    ...overrides,
    lifetime: { ...base.lifetime, ...overrides.lifetime },
    window: { ...base.window, ...overrides.window },
  };
}

function user(
  trustLevel: 0 | 1 | 2 | 3 | 4,
  options: { status?: "active" | "silenced"; locked?: boolean } = {},
) {
  return {
    trust_level: trustLevel,
    status: options.status ?? ("active" as const),
    level_locked: options.locked ? 1 : 0,
    created_at: NOW - 365 * DAY,
  };
}

describe("trust-level evaluation", () => {
  it("uses AND semantics and promotes at most one level per review", () => {
    const almost = metrics({
      lifetime: { ...metrics().lifetime, readingSeconds: 599 },
    });
    expect(meetsLevelOne(almost, rules[1])).toBe(false);
    expect(evaluateTrustLevel(user(0), rules, almost, NOW).targetLevel).toBeNull();
    expect(evaluateTrustLevel(user(0), rules, metrics(), NOW).targetLevel).toBe(1);
    expect(evaluateTrustLevel(user(1), rules, metrics(), NOW).targetLevel).toBe(2);
    expect(evaluateTrustLevel(user(2), rules, metrics(), NOW).targetLevel).toBe(3);
  });

  it("never auto-promotes silenced users and never changes locked or Lv4 users", () => {
    expect(
      evaluateTrustLevel(user(1, { status: "silenced" }), rules, metrics(), NOW)
        .targetLevel,
    ).toBeNull();
    expect(
      evaluateTrustLevel(user(2, { locked: true }), rules, metrics(), NOW)
        .targetLevel,
    ).toBeNull();
    expect(evaluateTrustLevel(user(4), rules, metrics(), NOW).targetLevel).toBeNull();
  });

  it("warns before Lv2 inactivity demotion and demotes at the deadline", () => {
    const inactive = metrics({
      window: {
        ...metrics().window,
        topicsEntered: 0,
        postsRead: 0,
        readingDays: 0,
        distinctTopicsReplied: 0,
        likesGiven: 0,
        likesReceived: 0,
        likeGiverCount: 0,
        likeDayCount: 0,
      },
      lastQualifyingActivityAt: NOW - 80 * DAY,
    });
    const warning = evaluateTrustLevel(user(2), rules, inactive, NOW);
    expect(warning.targetLevel).toBeNull();
    expect(warning.warning?.deadlineAt).toBe(NOW + 10 * DAY);

    const expired = metrics({
      ...inactive,
      lastQualifyingActivityAt: NOW - 91 * DAY,
    });
    const demotion = evaluateTrustLevel(user(2), rules, expired, NOW);
    expect(demotion.targetLevel).toBe(1);
    expect(demotion.reason).toBe("automatic_level_two_inactivity");
  });

  it("does not immediately re-promote an inactive user after Lv2 demotion", () => {
    const stale = metrics({ lastQualifyingActivityAt: NOW - 91 * DAY });
    expect(evaluateTrustLevel(user(2), rules, stale, NOW).targetLevel).toBe(1);
    expect(evaluateTrustLevel(user(1), rules, stale, NOW).targetLevel).toBeNull();

    const activeAgain = metrics({ lastQualifyingActivityAt: NOW });
    expect(evaluateTrustLevel(user(1), rules, activeAgain, NOW).targetLevel).toBe(
      2,
    );
  });

  it("applies the Lv3 90% hysteresis and first-promotion grace", () => {
    const belowFloor = metrics({
      window: { ...metrics().window, topicsEntered: 89 },
    });
    expect(meetsLevelThree(belowFloor, rules[3], 0.9)).toBe(false);
    expect(evaluateTrustLevel(user(3), rules, belowFloor, NOW).targetLevel).toBe(
      2,
    );

    const protectedMetrics = metrics({
      ...belowFloor,
      firstPromotedToLevelThreeAt: NOW - DAY,
    });
    const protectedDecision = evaluateTrustLevel(
      user(3),
      rules,
      protectedMetrics,
      NOW,
    );
    expect(protectedDecision.targetLevel).toBeNull();
    expect(protectedDecision.nextReviewAt).toBe(NOW + 13 * DAY);
  });

  it("treats accepted severe reports and sanctions as hard Lv3 failures", () => {
    expect(
      meetsLevelThree(
        metrics({
          window: { ...metrics().window, confirmedSevereReports: 1 },
        }),
        rules[3],
      ),
    ).toBe(false);
    expect(
      meetsLevelThree(
        metrics({ window: { ...metrics().window, recentSanctions: 1 } }),
        rules[3],
      ),
    ).toBe(false);
  });

  it("scopes Lv3 content denominators to current level and category ACL", () => {
    const scope = trustMetricDenominatorScope({
      id: "user-1",
      role: "member",
      status: "active",
      trust_level: 2,
      group_ids_json: "[]",
      moderated_category_ids_json: "[]",
    });
    expect(scope.bindings).toEqual([2]);
    expect(scope.clause).toContain("MAX(c.min_view_level");
    expect(scope.clause).toContain("c.acl_mode = 'open'");
    expect(scope.clause).not.toContain("cp.principal_id IN");

    const groupScope = trustMetricDenominatorScope({
      id: "user-1",
      role: "member",
      status: "active",
      trust_level: 2,
      group_ids_json: '["allowed-group"]',
      moderated_category_ids_json: "[]",
    });
    expect(groupScope.bindings).toEqual([2, "allowed-group"]);
  });

  it("uses report resolution time so recently accepted old reports count", () => {
    expect(CONFIRMED_REPORT_TIME_SQL).toBe(
      "COALESCE(reports.resolved_at, reports.created_at)",
    );
  });
});
