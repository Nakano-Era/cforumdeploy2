import { requestJson } from "./api";
import type { TrustLevel } from "./feed";

export interface CreateTopicRequest {
  categoryId: string;
  title: string;
  body: string;
  minViewLevel: TrustLevel;
}

export interface CreateTopicResponse {
  topic: {
    id: string;
    firstPostId: string;
    slug: string;
    status: "open" | "pending";
    reviewRequired: boolean;
  };
}

export interface BookmarkResponse {
  bookmark: {
    postId: string;
    active: boolean;
    changed: boolean;
  };
}

export async function createTopic(
  input: CreateTopicRequest,
  csrfToken: string,
): Promise<CreateTopicResponse> {
  return requestJson<CreateTopicResponse>("/api/topics", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-CSRF-Token": csrfToken,
    },
    body: JSON.stringify(input),
  });
}

export async function setPostBookmark(
  postId: string,
  desired: boolean,
  csrfToken: string,
): Promise<BookmarkResponse> {
  return requestJson<BookmarkResponse>(
    `/api/posts/${encodeURIComponent(postId)}/bookmark`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": csrfToken,
      },
      body: JSON.stringify({ desired }),
    },
  );
}
