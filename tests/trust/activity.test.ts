import { describe, expect, it } from "vitest";
import {
  recordReadingHeartbeat,
  recordTopicRead,
  utcActivityDate,
} from "@/worker/trust/activity";
import { readingHeartbeatSchema } from "@/worker/routes/activity";

interface FakeStatement {
  sql: string;
  bindings: unknown[];
  bind(...values: unknown[]): FakeStatement;
}

function database(captured: FakeStatement[][]): D1Database {
  return {
    prepare(sql: string) {
      const statement: FakeStatement = {
        sql,
        bindings: [],
        bind(...values: unknown[]) {
          statement.bindings = values;
          return statement;
        },
      };
      return statement as unknown as D1PreparedStatement;
    },
    async batch(statements: D1PreparedStatement[]) {
      captured.push(statements as unknown as FakeStatement[]);
      return statements.map((_, index) => ({
        success: true,
        results:
          index === 3 ? [{ reading_seconds: 120 }] : [],
        meta: { changes: index < 3 ? 1 : 0 },
      })) as D1Result[];
    },
  } as unknown as D1Database;
}

function oneHeartbeatPerMinuteDatabase(
  captured: FakeStatement[][],
): D1Database {
  let batchNumber = 0;
  return {
    prepare(sql: string) {
      const statement: FakeStatement = {
        sql,
        bindings: [],
        bind(...values: unknown[]) {
          statement.bindings = values;
          return statement;
        },
      };
      return statement as unknown as D1PreparedStatement;
    },
    async batch(statements: D1PreparedStatement[]) {
      captured.push(statements as unknown as FakeStatement[]);
      const rateLimitWon = batchNumber === 0;
      batchNumber += 1;
      return statements.map((_, index) => ({
        success: true,
        results: index === 3 ? [{ reading_seconds: 60 }] : [],
        meta: { changes: index < 3 && rateLimitWon ? 1 : 0 },
      })) as D1Result[];
    },
  } as unknown as D1Database;
}

describe("trust activity ingestion", () => {
  it("uses UTC activity dates", () => {
    expect(utcActivityDate(Date.UTC(2026, 7, 16, 23, 59) / 1_000)).toBe(
      "2026-08-16",
    );
  });

  it("records topic entry once per day and counts only published monotonic posts", async () => {
    const captured: FakeStatement[][] = [];
    await recordTopicRead(database(captured), {
      userId: "user-1",
      topicId: "topic-1",
      maxObservedPostNumber: 8,
      now: 100_000,
    });
    expect(captured[0]).toHaveLength(2);
    expect(captured[0]?.[0]?.sql).toContain("status = 'published'");
    expect(captured[0]?.[0]?.sql).toContain("last_read_post_number");
    expect(captured[0]?.[0]?.sql).toContain("last_read_at");
    expect(captured[0]?.[1]?.sql).toContain("MAX(\n             topic_reads.last_read_post_number");
  });

  it("bounds heartbeat claims and uses last_read_at as the replay guard", async () => {
    expect(
      readingHeartbeatSchema.safeParse({ topicId: "topic-1", seconds: 60 })
        .success,
    ).toBe(true);
    expect(
      readingHeartbeatSchema.safeParse({ topicId: "topic-1", seconds: 61 })
        .success,
    ).toBe(false);

    const captured: FakeStatement[][] = [];
    const result = await recordReadingHeartbeat(database(captured), {
      userId: "user-1",
      topicId: "topic-1",
      rateKeyHash: "opaque-user-key",
      seconds: 60,
      now: 100_000,
    });
    expect(result).toEqual({ accepted: true, readingSecondsToday: 120 });
    expect(captured[0]?.[0]?.sql).toContain("reading_heartbeat");
    expect(captured[0]?.[1]?.sql).toContain("last_read_at <= ?4 - ?3");
    expect(captured[0]?.[2]?.bindings).toContain(14_400);
  });

  it("gates topic_reads and reading credit on the once-per-minute claim", async () => {
    const captured: FakeStatement[][] = [];
    const fakeDatabase = oneHeartbeatPerMinuteDatabase(captured);
    const input = {
      userId: "user-1",
      topicId: "topic-1",
      rateKeyHash: "opaque-user-key",
      seconds: 5,
      now: 100_000,
    };
    expect((await recordReadingHeartbeat(fakeDatabase, input)).accepted).toBe(
      true,
    );
    expect((await recordReadingHeartbeat(fakeDatabase, input)).accepted).toBe(
      false,
    );
    expect(captured[1]?.[1]?.sql).toContain("AND changes() = 1");
    expect(captured[1]?.[2]?.sql).toContain("WHERE changes() = 1");
  });
});
