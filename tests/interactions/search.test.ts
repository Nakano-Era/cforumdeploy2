import { describe, expect, it } from "vitest";
import type { ViewerContext } from "@/worker/permissions/policy";
import { searchVisiblePosts } from "@/worker/repositories/interactions";
import {
  buildSafeFts5MatchQuery,
  decodeSearchCursor,
  encodeSearchCursor,
  normalizeSearchQuery,
} from "@/worker/routes/interactions";

interface CapturedStatement {
  sql: string;
  bindings: unknown[];
}

function searchDatabase(captured: CapturedStatement[]): D1Database {
  return {
    prepare(sql: string) {
      let bindings: unknown[] = [];
      const statement = {
        bind(...values: unknown[]) {
          bindings = values;
          return statement;
        },
        async all() {
          captured.push({ sql, bindings });
          return { success: true, results: [], meta: {} };
        },
      };
      return statement;
    },
  } as unknown as D1Database;
}

const guest: ViewerContext = {
  userId: null,
  role: "guest",
  status: "guest",
  trustLevel: null,
  groupIds: new Set(),
  moderatedCategoryIds: new Set(),
};

describe("safe FTS5 search", () => {
  it("normalizes Unicode and compiles only application-owned FTS syntax", () => {
    const normalized = normalizeSearchQuery(
      '  Ｔｉｔｌｅ：secret\tOR   foo*  "bar"  ',
    );
    expect(normalized).toBe('Title:secret OR foo* "bar"');
    expect(buildSafeFts5MatchQuery(normalized)).toBe(
      '"Title:secret" AND "OR" AND "foo*" AND """bar"""',
    );
    expect(buildSafeFts5MatchQuery("安全 安全 搜索")).toBe(
      '"安全" AND "搜索"',
    );
  });

  it("round-trips a Unicode query in a bounded keyset cursor", () => {
    const cursor = {
      query: "中文 搜索",
      rank: -2.718281828,
      createdAt: 1_750_000_000,
      postId: "post_01",
    };
    expect(decodeSearchCursor(encodeSearchCursor(cursor))).toEqual(cursor);
    expect(decodeSearchCursor("not-a-cursor")).toBeNull();
  });

  it("places MATCH and the shared guest visibility predicate in one query", async () => {
    const captured: CapturedStatement[] = [];
    const match = buildSafeFts5MatchQuery("hidden OR public*");
    await searchVisiblePosts(searchDatabase(captured), {
      viewer: guest,
      matchQuery: match,
      cursor: null,
      limit: 21,
    });

    expect(captured).toHaveLength(1);
    expect(captured[0]?.sql).toContain("post_search MATCH ?");
    expect(captured[0]?.sql).toContain("p.status = 'published'");
    expect(captured[0]?.sql).toContain("t.approval_status = 'approved'");
    expect(captured[0]?.sql).toContain("MAX(c.min_view_level");
    expect(captured[0]?.sql).toContain("cp.principal_type = 'everyone'");
    expect(captured[0]?.sql).not.toContain("hidden OR public*");
    expect(captured[0]?.bindings).toEqual([match, 0, 21]);
  });

  it("uses rank, timestamp, and post ID as a keyset without OFFSET", async () => {
    const captured: CapturedStatement[] = [];
    await searchVisiblePosts(searchDatabase(captured), {
      viewer: guest,
      matchQuery: '"cloudflare"',
      cursor: { rank: -1.25, createdAt: 200, postId: "post-b" },
      limit: 21,
    });

    expect(captured[0]?.sql).toContain("bm25(post_search");
    expect(captured[0]?.sql).toContain("p.created_at < ?");
    expect(captured[0]?.sql).toContain("p.id < ?");
    expect(captured[0]?.sql).not.toContain("OFFSET");
    expect(captured[0]?.bindings).toEqual([
      '"cloudflare"',
      0,
      -1.25,
      -1.25,
      200,
      200,
      "post-b",
      21,
    ]);
  });
});
