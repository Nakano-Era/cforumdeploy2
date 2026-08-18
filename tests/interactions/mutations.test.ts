import { describe, expect, it } from "vitest";
import {
  setLikeReaction,
  setPostBookmark,
} from "@/worker/repositories/interactions";

interface FakeStatement {
  sql: string;
  bindings: unknown[];
  bind(...values: unknown[]): FakeStatement;
}

function mutationDatabase(options: {
  mutationChanges: number;
  reactionActive?: number;
  bookmarkActive?: number;
  captured: FakeStatement[][];
}): D1Database {
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
      const captured = statements as unknown as FakeStatement[];
      options.captured.push(captured);
      if (captured.length === 4) {
        return [
          { success: true, results: [], meta: { changes: options.mutationChanges } },
          { success: true, results: [], meta: { changes: 1 } },
          { success: true, results: [], meta: { changes: 1 } },
          {
            success: true,
            results: [
              {
                post_like_count: 3,
                topic_like_count: 8,
                active: options.reactionActive ?? 1,
              },
            ],
            meta: { changes: 0 },
          },
        ] as D1Result[];
      }
      return [
        { success: true, results: [], meta: { changes: options.mutationChanges } },
        {
          success: true,
          results: [{ active: options.bookmarkActive ?? 1 }],
          meta: { changes: 0 },
        },
      ] as D1Result[];
    },
  } as unknown as D1Database;
}

describe("interaction persistence", () => {
  it("adds a like idempotently and exactly recounts post and topic likes", async () => {
    const captured: FakeStatement[][] = [];
    const result = await setLikeReaction(
      mutationDatabase({ mutationChanges: 1, captured }),
      {
        postId: "post-1",
        topicId: "topic-1",
        userId: "user-1",
        desired: true,
        now: 100,
      },
    );

    expect(result).toEqual({
      changed: true,
      active: true,
      postLikeCount: 3,
      topicLikeCount: 8,
    });
    expect(captured[0]?.[0]?.sql).toContain(
      "ON CONFLICT(post_id, user_id, reaction_type) DO NOTHING",
    );
    expect(captured[0]?.[0]?.sql).toContain("status = 'active'");
    expect(captured[0]?.[1]?.sql).toContain("SELECT COUNT(*)");
    expect(captured[0]?.[2]?.sql).toContain("JOIN posts counted_post");
    expect(captured[0]?.[2]?.sql).toContain("reaction_type = 'like'");
  });

  it("reports an explicit like retry as unchanged without changing state", async () => {
    const captured: FakeStatement[][] = [];
    const result = await setLikeReaction(
      mutationDatabase({ mutationChanges: 0, reactionActive: 1, captured }),
      {
        postId: "post-1",
        topicId: "topic-1",
        userId: "user-1",
        desired: true,
        now: 100,
      },
    );
    expect(result.changed).toBe(false);
    expect(result.active).toBe(true);
  });

  it("removes a like with the same active-user and parent-state guards", async () => {
    const captured: FakeStatement[][] = [];
    const result = await setLikeReaction(
      mutationDatabase({ mutationChanges: 1, reactionActive: 0, captured }),
      {
        postId: "post-1",
        topicId: "topic-1",
        userId: "user-1",
        desired: false,
        now: 100,
      },
    );
    expect(result.active).toBe(false);
    expect(captured[0]?.[0]?.sql).toContain("DELETE FROM reactions");
    expect(captured[0]?.[0]?.sql).toContain("guarded_post.topic_id = ?3");
  });

  it("uses the bookmarks_identity expression for idempotent set and clear", async () => {
    const addedStatements: FakeStatement[][] = [];
    const added = await setPostBookmark(
      mutationDatabase({ mutationChanges: 1, bookmarkActive: 1, captured: addedStatements }),
      {
        postId: "post-1",
        topicId: "topic-from-server",
        userId: "user-1",
        desired: true,
        now: 100,
      },
    );
    expect(added).toEqual({ changed: true, active: true });
    expect(addedStatements[0]?.[0]?.sql).toContain(
      "COALESCE(existing.post_id, '') = ?1",
    );
    expect(addedStatements[0]?.[0]?.sql).toContain("ON CONFLICT DO NOTHING");
    expect(addedStatements[0]?.[0]?.bindings[2]).toBe("topic-from-server");

    const removedStatements: FakeStatement[][] = [];
    const removed = await setPostBookmark(
      mutationDatabase({ mutationChanges: 0, bookmarkActive: 0, captured: removedStatements }),
      {
        postId: "post-1",
        topicId: "topic-from-server",
        userId: "user-1",
        desired: false,
        now: 101,
      },
    );
    expect(removed).toEqual({ changed: false, active: false });
    expect(removedStatements[0]?.[0]?.sql).toContain("DELETE FROM bookmarks");
    expect(removedStatements[0]?.[0]?.sql).toContain(
      "COALESCE(post_id, '') = ?1",
    );
  });
});
