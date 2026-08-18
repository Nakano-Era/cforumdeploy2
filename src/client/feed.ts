import { apiErrorFromResponse } from "./api";

export type FeedTab = "all" | "latest" | "hot" | "following" | "unread";

export type TrustLevel = 0 | 1 | 2 | 3 | 4;

export type TopicVisibility =
  | { kind: "public" }
  | { kind: "trust_level"; minLevel: TrustLevel }
  | { kind: "group"; label: string; minLevel: TrustLevel };

export interface FeedViewer {
  id: string;
  displayName: string;
  trustLevel: TrustLevel;
  unreadNotifications: number;
}

export interface CategorySummary {
  id: string;
  slug: string;
  name: string;
  description: string;
  accent: string;
  topicCount: number;
  unreadCount: number;
  minViewLevel: TrustLevel;
  allowImages: boolean;
  canCreate: boolean;
  allowedTopicMinLevelMax: TrustLevel;
}

export interface TopicAuthor {
  id: string;
  displayName: string;
  handle: string;
  initials: string;
  avatarTone: "coral" | "moss" | "blue" | "gold" | "plum";
  avatarUrl?: string | null;
  trustLevel: TrustLevel;
}

export interface FeedTopic {
  id: string;
  firstPostId: string;
  slug: string;
  title: string;
  excerpt: string;
  category: Pick<CategorySummary, "id" | "slug" | "name" | "accent">;
  author: TopicAuthor;
  tags: string[];
  visibility: TopicVisibility;
  replyCount: number;
  likeCount: number;
  participantCount: number;
  bumpedAt: string;
  lastPosterName: string;
  pinned: boolean;
  featured: boolean;
  locked: boolean;
  bookmarked: boolean;
  unreadPosts: number;
  signals: {
    hot: boolean;
    followed: boolean;
    newToViewer: boolean;
  };
  coverTone?: "blueprint" | "books" | "garden";
}

export interface CommunityPulse {
  membersOnline: number;
  newTopicsToday: number;
  repliesToday: number;
  activeMembersThisWeek: number;
}

/**
 * Contract for GET /api/feed. The API should apply category, group and topic-level
 * visibility before constructing this payload; the client must never be relied on
 * to hide inaccessible topics.
 */
export interface FeedResponse {
  viewer: FeedViewer | null;
  topics: FeedTopic[];
  categories: CategorySummary[];
  pulse: CommunityPulse;
  nextCursor: string | null;
  generatedAt: string;
}

export interface FeedQuery {
  tab: FeedTab;
  cursor?: string;
  category?: string;
  minLevel?: TrustLevel;
  tag?: string;
  search?: string;
}

export async function getFeed(
  query: FeedQuery,
  signal?: AbortSignal,
): Promise<FeedResponse> {
  const params = new URLSearchParams({ tab: query.tab });
  if (query.cursor) params.set("cursor", query.cursor);
  if (query.category) params.set("category", query.category);
  if (query.minLevel !== undefined) params.set("min_level", String(query.minLevel));
  if (query.tag) params.set("tag", query.tag);
  if (query.search) params.set("q", query.search);

  const response = await fetch(`/api/feed?${params.toString()}`, {
    credentials: "same-origin",
    headers: { Accept: "application/json" },
    signal,
  });

  if (!response.ok) {
    throw await apiErrorFromResponse(response);
  }

  return (await response.json()) as FeedResponse;
}

export const mockFeed: FeedResponse = {
  viewer: {
    id: "u-demo",
    displayName: "许知行",
    trustLevel: 3,
    unreadNotifications: 4,
  },
  generatedAt: "2026-08-16T08:10:00.000Z",
  nextCursor: "2026-08-15T09:40:00.000Z_t-1052",
  pulse: {
    membersOnline: 86,
    newTopicsToday: 24,
    repliesToday: 187,
    activeMembersThisWeek: 1248,
  },
  categories: [
    {
      id: "c-announcements",
      slug: "announcements",
      name: "站务与公告",
      description: "社区规则、更新与共同决定",
      accent: "#d65b43",
      topicCount: 42,
      unreadCount: 1,
      minViewLevel: 0,
      allowImages: false,
      canCreate: true,
      allowedTopicMinLevelMax: 4,
    },
    {
      id: "c-product",
      slug: "product-design",
      name: "产品与设计",
      description: "产品思考、设计过程与作品复盘",
      accent: "#397f73",
      topicCount: 386,
      unreadCount: 7,
      minViewLevel: 0,
      allowImages: true,
      canCreate: true,
      allowedTopicMinLevelMax: 3,
    },
    {
      id: "c-engineering",
      slug: "engineering",
      name: "工程技术",
      description: "代码、架构和正在解决的问题",
      accent: "#4b6ea9",
      topicCount: 512,
      unreadCount: 12,
      minViewLevel: 0,
      allowImages: true,
      canCreate: true,
      allowedTopicMinLevelMax: 4,
    },
    {
      id: "c-reading",
      slug: "reading-writing",
      name: "读书与创作",
      description: "阅读札记、写作练习与长期项目",
      accent: "#9a7144",
      topicCount: 274,
      unreadCount: 3,
      minViewLevel: 0,
      allowImages: true,
      canCreate: true,
      allowedTopicMinLevelMax: 3,
    },
    {
      id: "c-lounge",
      slug: "lounge",
      name: "生活与闲聊",
      description: "日常观察、城市漫步与轻松话题",
      accent: "#8b648b",
      topicCount: 738,
      unreadCount: 0,
      minViewLevel: 1,
      allowImages: true,
      canCreate: true,
      allowedTopicMinLevelMax: 3,
    },
  ],
  topics: [
    {
      id: "t-1048",
      firstPostId: "p-1048-1",
      slug: "community-guidelines-refresh",
      title: "社区公约更新：让高质量讨论被更多人看见",
      excerpt:
        "我们重新整理了发帖、引用和争议讨论的边界。规则没有变得更多，只是希望每个人都更容易知道：什么样的表达会让对话继续。",
      category: {
        id: "c-announcements",
        slug: "announcements",
        name: "站务与公告",
        accent: "#d65b43",
      },
      author: {
        id: "u-lin",
        displayName: "林默",
        handle: "linmo",
        initials: "林",
        avatarTone: "coral",
        trustLevel: 4,
      },
      tags: ["社区治理", "必读"],
      visibility: { kind: "public" },
      replyCount: 36,
      likeCount: 128,
      participantCount: 19,
      bumpedAt: "2026-08-16T07:42:00.000Z",
      lastPosterName: "山茶",
      pinned: true,
      featured: true,
      locked: false,
      bookmarked: false,
      unreadPosts: 3,
      signals: { hot: true, followed: true, newToViewer: false },
    },
    {
      id: "t-1064",
      firstPostId: "p-1064-1",
      slug: "d1-query-from-180-to-23ms",
      title: "把一条 D1 查询从 180ms 优化到 23ms，我具体改了什么",
      excerpt:
        "问题不在 SQL 有多长，而在权限过滤和时间排序各走各的索引。这里记录一次从查询计划开始、逐步收窄读取行数的完整过程。",
      category: {
        id: "c-engineering",
        slug: "engineering",
        name: "工程技术",
        accent: "#4b6ea9",
      },
      author: {
        id: "u-xia",
        displayName: "夏桥",
        handle: "xia-qiao",
        initials: "夏",
        avatarTone: "blue",
        trustLevel: 3,
      },
      tags: ["Cloudflare", "性能", "实践"],
      visibility: { kind: "public" },
      replyCount: 22,
      likeCount: 91,
      participantCount: 14,
      bumpedAt: "2026-08-16T06:16:00.000Z",
      lastPosterName: "纸飞机",
      pinned: false,
      featured: true,
      locked: false,
      bookmarked: true,
      unreadPosts: 7,
      signals: { hot: true, followed: true, newToViewer: false },
      coverTone: "blueprint",
    },
    {
      id: "t-1061",
      firstPostId: "p-1061-1",
      slug: "small-community-first-1000-users",
      title: "小型社区的前 1,000 位成员，应该如何被认真对待？",
      excerpt:
        "与其用增长漏斗描述早期成员，我更愿意把他们看作一起定义文化的编辑委员会。整理了五个看起来很慢、长期却更快的做法。",
      category: {
        id: "c-product",
        slug: "product-design",
        name: "产品与设计",
        accent: "#397f73",
      },
      author: {
        id: "u-chen",
        displayName: "陈屿",
        handle: "islandchen",
        initials: "陈",
        avatarTone: "moss",
        trustLevel: 2,
      },
      tags: ["社区", "产品思考"],
      visibility: { kind: "public" },
      replyCount: 48,
      likeCount: 174,
      participantCount: 31,
      bumpedAt: "2026-08-16T04:55:00.000Z",
      lastPosterName: "阿策",
      pinned: false,
      featured: false,
      locked: false,
      bookmarked: false,
      unreadPosts: 0,
      signals: { hot: true, followed: false, newToViewer: true },
    },
    {
      id: "t-1058",
      firstPostId: "p-1058-1",
      slug: "a-reading-system-that-lasts",
      title: "我做了一个能坚持一年的阅读系统：不打卡，也不追求数量",
      excerpt:
        "记录不是为了证明读过，而是给未来的自己留一条返回原文的路。分享我的三层笔记法，以及为什么它终于没有在第三周失效。",
      category: {
        id: "c-reading",
        slug: "reading-writing",
        name: "读书与创作",
        accent: "#9a7144",
      },
      author: {
        id: "u-qiu",
        displayName: "秋池",
        handle: "autumnpond",
        initials: "秋",
        avatarTone: "gold",
        trustLevel: 2,
      },
      tags: ["阅读", "方法"],
      visibility: { kind: "public" },
      replyCount: 19,
      likeCount: 76,
      participantCount: 12,
      bumpedAt: "2026-08-16T03:28:00.000Z",
      lastPosterName: "木棉",
      pinned: false,
      featured: true,
      locked: false,
      bookmarked: false,
      unreadPosts: 2,
      signals: { hot: false, followed: true, newToViewer: false },
      coverTone: "books",
    },
    {
      id: "t-1055",
      firstPostId: "p-1055-1",
      slug: "design-review-notes-08",
      title: "设计评审记录 08：真正需要被解释的不是按钮",
      excerpt:
        "一次顺利的评审，不只是决定界面长什么样，也要把信息的先后、例外状态和用户为什么信任这个流程说清楚。",
      category: {
        id: "c-product",
        slug: "product-design",
        name: "产品与设计",
        accent: "#397f73",
      },
      author: {
        id: "u-ruo",
        displayName: "若岚",
        handle: "ruolan",
        initials: "若",
        avatarTone: "plum",
        trustLevel: 3,
      },
      tags: ["设计评审", "工作方法"],
      visibility: { kind: "trust_level", minLevel: 2 },
      replyCount: 14,
      likeCount: 52,
      participantCount: 9,
      bumpedAt: "2026-08-15T22:10:00.000Z",
      lastPosterName: "夏桥",
      pinned: false,
      featured: false,
      locked: false,
      bookmarked: true,
      unreadPosts: 4,
      signals: { hot: false, followed: true, newToViewer: false },
    },
    {
      id: "t-1053",
      firstPostId: "p-1053-1",
      slug: "weekend-balcony-garden",
      title: "周末阳台计划：四平方米也能有一小块会呼吸的花园",
      excerpt:
        "从日照时间、排水到对猫友好的植物，画了一份尽量不折腾的布置清单。也欢迎晒晒你们窗边那一点绿色。",
      category: {
        id: "c-lounge",
        slug: "lounge",
        name: "生活与闲聊",
        accent: "#8b648b",
      },
      author: {
        id: "u-shan",
        displayName: "山茶",
        handle: "camellia",
        initials: "山",
        avatarTone: "moss",
        trustLevel: 1,
      },
      tags: ["生活", "植物"],
      visibility: { kind: "trust_level", minLevel: 1 },
      replyCount: 27,
      likeCount: 88,
      participantCount: 17,
      bumpedAt: "2026-08-15T15:42:00.000Z",
      lastPosterName: "季风",
      pinned: false,
      featured: false,
      locked: false,
      bookmarked: false,
      unreadPosts: 0,
      signals: { hot: true, followed: false, newToViewer: true },
      coverTone: "garden",
    },
    {
      id: "t-1052",
      firstPostId: "p-1052-1",
      slug: "maintainers-room-august",
      title: "八月维护者圆桌：审核节奏与透明度",
      excerpt:
        "本月内部圆桌聚焦审核时效、申诉反馈和敏感信息处理，议题结论会在整理后公开发布。",
      category: {
        id: "c-announcements",
        slug: "announcements",
        name: "站务与公告",
        accent: "#d65b43",
      },
      author: {
        id: "u-lin",
        displayName: "林默",
        handle: "linmo",
        initials: "林",
        avatarTone: "coral",
        trustLevel: 4,
      },
      tags: ["审核"],
      visibility: { kind: "group", label: "维护者", minLevel: 3 },
      replyCount: 8,
      likeCount: 21,
      participantCount: 6,
      bumpedAt: "2026-08-15T09:40:00.000Z",
      lastPosterName: "若岚",
      pinned: false,
      featured: false,
      locked: true,
      bookmarked: false,
      unreadPosts: 1,
      signals: { hot: false, followed: false, newToViewer: false },
    },
  ],
};

/** Only used when Vite is explicitly started with VITE_DEMO_MODE=true. */
export function getDemoFeed(query: FeedQuery): FeedResponse {
  const search = query.search?.trim().toLocaleLowerCase("zh-CN") ?? "";
  const topics = mockFeed.topics
    .filter((topic) => {
      if (query.category && topic.category.slug !== query.category) return false;
      if (
        query.minLevel !== undefined &&
        (topic.visibility.kind === "public" ? 0 : topic.visibility.minLevel) >
          query.minLevel
      ) {
        return false;
      }
      if (query.tab === "hot" && !topic.signals.hot) return false;
      if (query.tab === "following" && !topic.signals.followed) return false;
      if (
        query.tab === "unread" &&
        topic.unreadPosts === 0 &&
        !topic.signals.newToViewer
      ) {
        return false;
      }
      if (!search) return true;
      return [topic.title, topic.excerpt, ...topic.tags]
        .join(" ")
        .toLocaleLowerCase("zh-CN")
        .includes(search);
    })
    .sort((left, right) => {
      if (query.tab === "all" && left.pinned !== right.pinned) {
        return left.pinned ? -1 : 1;
      }
      if (query.tab === "hot") {
        return (
          right.likeCount * 2 +
          right.replyCount -
          (left.likeCount * 2 + left.replyCount)
        );
      }
      return new Date(right.bumpedAt).getTime() - new Date(left.bumpedAt).getTime();
    });

  return { ...mockFeed, topics, nextCursor: null, generatedAt: new Date().toISOString() };
}
