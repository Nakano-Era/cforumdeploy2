import { Hono, type Context } from "hono";
import { z } from "zod";
import type { RequestIdentity } from "@/worker/auth/session";
import type { AppEnv } from "@/worker/env";
import { evaluateViewTopic } from "@/worker/permissions/policy";
import {
  getPublishedInteractionTarget,
  searchVisiblePosts,
  setLikeReaction,
  setPostBookmark,
  type InteractionTarget,
  type SearchKeyset,
} from "@/worker/repositories/interactions";
import { getTopicAggregate } from "@/worker/repositories/forum";
import { nowSeconds } from "@/worker/security/crypto";

const SEARCH_PAGE_SIZE = 20;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const idSchema = z.string().min(1).max(80).regex(/^[A-Za-z0-9_-]+$/);

export function normalizeSearchQuery(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ");
}

function unicodeLength(value: string): number {
  return [...value].length;
}

const normalizedQuerySchema = z
  .string()
  .max(256)
  .transform(normalizeSearchQuery)
  .refine((value) => unicodeLength(value) >= 2, "Search query is too short")
  .refine((value) => unicodeLength(value) <= 80, "Search query is too long")
  .refine((value) => !/\p{Cc}/u.test(value), "Control characters are not allowed")
  .refine((value) => /[\p{L}\p{N}]/u.test(value), "No searchable terms")
  .refine(
    (value) => value.split(" ").length <= 8,
    "Too many search terms",
  );

const searchQuerySchema = z.object({
  q: normalizedQuerySchema,
  cursor: z.string().min(1).max(512).optional(),
});

const searchCursorSchema = z.object({
  query: normalizedQuerySchema,
  rank: z.number().finite(),
  createdAt: z.number().int().nonnegative(),
  postId: idSchema,
});

const reactionSchema = z
  .object({
    type: z.literal("like").default("like"),
    desired: z.boolean(),
  })
  .strict();

const bookmarkSchema = z.object({ desired: z.boolean() }).strict();

interface SearchCursor extends SearchKeyset {
  query: string;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

export function encodeSearchCursor(cursor: SearchCursor): string {
  return bytesToBase64Url(encoder.encode(JSON.stringify(cursor)));
}

export function decodeSearchCursor(value: string): SearchCursor | null {
  try {
    const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) =>
      character.charCodeAt(0),
    );
    const parsed = searchCursorSchema.safeParse(
      JSON.parse(decoder.decode(bytes)),
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Every user fragment is an FTS5 quoted string. Doubling quotes is FTS5's
 * string escape, so operators, column filters, prefix markers and NEAR syntax
 * remain literal tokenizer input instead of executable MATCH syntax.
 */
export function buildSafeFts5MatchQuery(normalizedQuery: string): string {
  return [...new Set(normalizedQuery.split(" "))]
    .map((term) => `"${term.replaceAll('"', '""')}"`)
    .join(" AND ");
}

function requestIdentity(context: Context<AppEnv>): RequestIdentity | undefined {
  return context.get("identity") as RequestIdentity | undefined;
}

async function visibleInteractionTarget(
  context: Context<AppEnv>,
  postId: string,
): Promise<InteractionTarget | null> {
  const target = await getPublishedInteractionTarget(
    context.env.CFORUM_DB,
    postId,
  );
  if (!target) return null;
  const aggregate = await getTopicAggregate(
    context.env.CFORUM_DB,
    target.topicId,
  );
  if (!aggregate || aggregate.topic.id !== target.topicId) return null;
  const identity = requestIdentity(context);
  if (!identity) return null;
  const decision = evaluateViewTopic(
    identity.viewer,
    aggregate.category,
    aggregate.topic,
  );
  return decision.allowed ? target : null;
}

function activeUser(context: Context<AppEnv>):
  | { userId: string }
  | { response: Response } {
  const identity = requestIdentity(context);
  if (!identity?.session || !identity.viewer.userId) {
    return {
      response: context.json(
        { error: { code: "AUTHENTICATION_REQUIRED" } },
        401,
      ),
    };
  }
  if (identity.viewer.status !== "active") {
    return {
      response: context.json({ error: { code: "ACCOUNT_NOT_ACTIVE" } }, 403),
    };
  }
  return { userId: identity.viewer.userId };
}

function isoFromSeconds(seconds: number): string {
  return new Date(seconds * 1_000).toISOString();
}

const router = new Hono<AppEnv>();

router.get("/search", async (context) => {
  const parsed = searchQuerySchema.safeParse(context.req.query());
  if (!parsed.success) {
    return context.json({ error: { code: "INVALID_QUERY" } }, 422);
  }
  const cursor = parsed.data.cursor
    ? decodeSearchCursor(parsed.data.cursor)
    : null;
  if (
    parsed.data.cursor &&
    (!cursor || cursor.query !== parsed.data.q)
  ) {
    return context.json({ error: { code: "INVALID_CURSOR" } }, 422);
  }

  try {
    const rows = await searchVisiblePosts(context.env.CFORUM_DB, {
      viewer: requestIdentity(context)?.viewer ?? {
        userId: null,
        role: "guest",
        status: "guest",
        trustLevel: null,
        groupIds: new Set(),
        moderatedCategoryIds: new Set(),
      },
      matchQuery: buildSafeFts5MatchQuery(parsed.data.q),
      cursor,
      limit: SEARCH_PAGE_SIZE + 1,
    });
    const pageRows = rows.slice(0, SEARCH_PAGE_SIZE);
    const hasMore = rows.length > SEARCH_PAGE_SIZE;
    const last = hasMore ? pageRows.at(-1) : undefined;
    return context.json({
      query: parsed.data.q,
      results: pageRows.map((row) => ({
        post: {
          id: row.post_id,
          number: row.post_number,
          excerpt: row.excerpt,
          likeCount: row.post_like_count,
          createdAt: isoFromSeconds(row.post_created_at),
        },
        topic: {
          id: row.topic_id,
          slug: row.topic_slug,
          title: row.topic_title,
        },
        category: {
          id: row.category_id,
          slug: row.category_slug,
          name: row.category_name,
          color: row.category_color,
        },
        author: {
          id: row.author_id,
          username: row.username,
          displayName: row.display_name,
        },
      })),
      nextCursor:
        last && hasMore
          ? encodeSearchCursor({
              query: parsed.data.q,
              rank: last.rank,
              createdAt: last.post_created_at,
              postId: last.post_id,
            })
          : null,
    });
  } catch {
    return context.json({ error: { code: "SEARCH_UNAVAILABLE" } }, 503);
  }
});

router.post("/posts/:id/reactions", async (context) => {
  const user = activeUser(context);
  if ("response" in user) return user.response;
  const postId = context.req.param("id");
  if (!idSchema.safeParse(postId).success) {
    return context.json({ error: { code: "NOT_FOUND" } }, 404);
  }
  const parsed = reactionSchema.safeParse(
    await context.req.json().catch(() => null),
  );
  if (!parsed.success) {
    return context.json({ error: { code: "INVALID_INPUT" } }, 422);
  }
  const target = await visibleInteractionTarget(context, postId);
  if (!target) {
    return context.json({ error: { code: "NOT_FOUND" } }, 404);
  }
  const result = await setLikeReaction(context.env.CFORUM_DB, {
    postId,
    topicId: target.topicId,
    userId: user.userId,
    desired: parsed.data.desired,
    now: nowSeconds(),
  });
  return context.json({
    reaction: {
      type: parsed.data.type,
      active: result.active,
      changed: result.changed,
    },
    post: { id: postId, likeCount: result.postLikeCount },
    topic: { id: target.topicId, likeCount: result.topicLikeCount },
  });
});

router.post("/posts/:id/bookmark", async (context) => {
  const user = activeUser(context);
  if ("response" in user) return user.response;
  const postId = context.req.param("id");
  if (!idSchema.safeParse(postId).success) {
    return context.json({ error: { code: "NOT_FOUND" } }, 404);
  }
  const parsed = bookmarkSchema.safeParse(
    await context.req.json().catch(() => null),
  );
  if (!parsed.success) {
    return context.json({ error: { code: "INVALID_INPUT" } }, 422);
  }
  const target = await visibleInteractionTarget(context, postId);
  if (!target) {
    return context.json({ error: { code: "NOT_FOUND" } }, 404);
  }
  const result = await setPostBookmark(context.env.CFORUM_DB, {
    postId,
    topicId: target.topicId,
    userId: user.userId,
    desired: parsed.data.desired,
    now: nowSeconds(),
  });
  return context.json({
    bookmark: {
      postId,
      active: result.active,
      changed: result.changed,
    },
  });
});

export default router;
