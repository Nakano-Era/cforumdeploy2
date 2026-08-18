import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getTopicDetail,
  setTopicPinned,
  type TopicDetailResponse,
  type TopicPinResponse,
} from "@/client/topic";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("topic pinning client contract", () => {
  it("sends an explicit desired state with the session CSRF token", async () => {
    const payload: TopicPinResponse = {
      topic: { id: "topic-1", pinned: true },
      changed: true,
    };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      setTopicPinned("topic-1", true, "csrf-token"),
    ).resolves.toEqual(payload);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/topics/topic-1/pin");
    expect(init).toMatchObject({
      method: "PATCH",
      credentials: "same-origin",
      body: JSON.stringify({ desired: true }),
    });
    expect(init.headers).toMatchObject({
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-CSRF-Token": "csrf-token",
    });
  });

  it("retains the server-projected pinned state in the detail contract", async () => {
    const payload = {
      topic: {
        id: "topic-1",
        slug: "topic-1",
        title: "测试主题",
        status: "open",
        minViewLevel: 0,
        effectiveMinViewLevel: 0,
        replyCount: 0,
        likeCount: 0,
        pinned: true,
        bumpedAt: "2026-08-19T00:00:00.000Z",
        createdAt: "2026-08-19T00:00:00.000Z",
        category: {
          id: "category-1",
          slug: "general",
          name: "综合讨论",
          accent: "#123456",
        },
        author: {
          id: "author-1",
          username: "author",
          displayName: "作者",
          trustLevel: 1,
          avatarUrl: null,
        },
      },
      posts: [],
      tags: [],
      access: {
        readOnly: false,
        canReply: true,
        replyReason: "allowed",
        via: "allowed",
      },
    } satisfies TopicDetailResponse;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    const detail = await getTopicDetail("topic-1");
    expect(detail.topic.pinned).toBe(true);
  });
});
