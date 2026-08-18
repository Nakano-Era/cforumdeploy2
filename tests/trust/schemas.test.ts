import { describe, expect, it } from "vitest";
import {
  levelFourRuleSchema,
  levelThreeRuleSchema,
  levelTwoRuleSchema,
  trustRulePatchRequestSchema,
} from "@/worker/trust/schemas";

describe("trust rule schemas", () => {
  it("accepts the bounded default Lv2 and Lv3 rules", () => {
    expect(
      levelTwoRuleSchema.safeParse({
        topicsEntered: 20,
        postsRead: 100,
        readingSeconds: 3_600,
        visitDays: 15,
        distinctTopicsReplied: 3,
        likesGiven: 1,
        likesReceived: 1,
        demoteAfterInactiveDays: 90,
        warningDays: 14,
      }).success,
    ).toBe(true);
    expect(
      levelThreeRuleSchema.safeParse({
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
      }).success,
    ).toBe(true);
  });

  it("rejects impossible cross-field rules, unknown fields and automatic Lv4", () => {
    const invalidLv2 = {
      topicsEntered: 20,
      postsRead: 100,
      readingSeconds: 3_600,
      visitDays: 15,
      distinctTopicsReplied: 3,
      likesGiven: 1,
      likesReceived: 1,
      demoteAfterInactiveDays: 14,
      warningDays: 14,
    };
    expect(levelTwoRuleSchema.safeParse(invalidLv2).success).toBe(false);
    expect(levelFourRuleSchema.safeParse({ manualOnly: false }).success).toBe(
      false,
    );
    expect(
      trustRulePatchRequestSchema.safeParse({
        expectedUpdatedAt: 1,
        rule: { manualOnly: true },
        arbitrary: true,
      }).success,
    ).toBe(false);
  });
});
