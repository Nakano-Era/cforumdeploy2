import { z } from "zod";

const metricCount = z.number().int().min(0).max(10_000_000);
const readingSeconds = z.number().int().min(0).max(31_536_000);
const dayCount = z.number().int().min(0).max(3_650);
const percentage = z.number().finite().gt(0).max(100);

export const levelOneRuleSchema = z
  .object({
    topicsEntered: metricCount,
    postsRead: metricCount,
    readingSeconds,
  })
  .strict();

export const levelTwoRuleSchema = z
  .object({
    topicsEntered: metricCount,
    postsRead: metricCount,
    readingSeconds,
    visitDays: dayCount,
    distinctTopicsReplied: metricCount,
    likesGiven: metricCount,
    likesReceived: metricCount,
    demoteAfterInactiveDays: z.number().int().min(1).max(3_650),
    warningDays: z.number().int().min(0).max(365),
  })
  .strict()
  .superRefine((rule, context) => {
    if (rule.warningDays >= rule.demoteAfterInactiveDays) {
      context.addIssue({
        code: "custom",
        message: "warningDays 必须小于 demoteAfterInactiveDays",
        path: ["warningDays"],
      });
    }
  });

export const levelThreeRuleSchema = z
  .object({
    windowDays: z.union([
      z.literal(7),
      z.literal(30),
      z.literal(90),
      z.literal(100),
      z.literal(180),
    ]),
    topicPercent: percentage,
    topicCap: metricCount,
    postPercent: percentage,
    postCap: metricCount,
    distinctTopicsReplied: metricCount,
    readingDays: dayCount,
    likesGiven: metricCount,
    likesReceived: metricCount,
    likeGiverCount: metricCount,
    likeDayCount: dayCount,
    maxConfirmedSevereReports: z.number().int().min(0).max(1_000),
    sanctionFreeDays: z.number().int().min(1).max(3_650),
    graceDays: z.number().int().min(0).max(365),
    demotionRatio: z.number().finite().gt(0).max(1),
  })
  .strict()
  .superRefine((rule, context) => {
    if (rule.readingDays > rule.windowDays) {
      context.addIssue({
        code: "custom",
        message: "readingDays 不能大于 windowDays",
        path: ["readingDays"],
      });
    }
    if (rule.likeGiverCount > rule.likesReceived) {
      context.addIssue({
        code: "custom",
        message: "likeGiverCount 不能大于 likesReceived",
        path: ["likeGiverCount"],
      });
    }
    if (
      rule.likeDayCount > rule.windowDays ||
      rule.likeDayCount > rule.likesReceived
    ) {
      context.addIssue({
        code: "custom",
        message: "likeDayCount 不能大于窗口天数或获赞数",
        path: ["likeDayCount"],
      });
    }
  });

export const levelFourRuleSchema = z
  .object({ manualOnly: z.literal(true) })
  .strict();

export type LevelOneRule = z.infer<typeof levelOneRuleSchema>;
export type LevelTwoRule = z.infer<typeof levelTwoRuleSchema>;
export type LevelThreeRule = z.infer<typeof levelThreeRuleSchema>;
export type LevelFourRule = z.infer<typeof levelFourRuleSchema>;

export interface TrustRules {
  1: LevelOneRule;
  2: LevelTwoRule;
  3: LevelThreeRule;
  4: LevelFourRule;
}

export const trustRulePatchRequestSchema = z
  .object({
    expectedUpdatedAt: z.number().int().nonnegative(),
    rule: z.unknown(),
  })
  .strict();

export function parseTrustRule(
  level: 1 | 2 | 3 | 4,
  value: unknown,
): LevelOneRule | LevelTwoRule | LevelThreeRule | LevelFourRule {
  switch (level) {
    case 1:
      return levelOneRuleSchema.parse(value);
    case 2:
      return levelTwoRuleSchema.parse(value);
    case 3:
      return levelThreeRuleSchema.parse(value);
    case 4:
      return levelFourRuleSchema.parse(value);
  }
}

export function safeParseTrustRule(
  level: 1 | 2 | 3 | 4,
  value: unknown,
) {
  switch (level) {
    case 1:
      return levelOneRuleSchema.safeParse(value);
    case 2:
      return levelTwoRuleSchema.safeParse(value);
    case 3:
      return levelThreeRuleSchema.safeParse(value);
    case 4:
      return levelFourRuleSchema.safeParse(value);
  }
}
