import { requestJson } from "./api";

export type ReportType =
  | "off_topic"
  | "inappropriate"
  | "spam"
  | "illegal"
  | "other";

export interface SubmitReportResponse {
  report: {
    id: string;
    status: "open" | "accepted" | "rejected" | "withdrawn";
  };
  created: boolean;
}

export interface ReviewItem {
  id: string;
  type: string;
  status: string;
  priority: number;
  triggerReason: string;
  createdAt: string;
  category: {
    id: string;
    name: string;
  } | null;
  submittedBy: {
    id: string;
    username: string;
    displayName: string;
  } | null;
  target: {
    userId: string | null;
    topicId: string | null;
    postId: string | null;
    title: string | null;
    postNumber: number | null;
    excerpt: string | null;
  };
  snapshot: unknown;
}

export interface ReviewQueueResponse {
  items: ReviewItem[];
  nextCursor: string | null;
  capabilities: {
    scope: "global" | "categories";
    categoryIds: string[];
  };
}

export interface ReviewDecisionResponse {
  item: {
    id: string;
    status: "approved" | "rejected";
    action: string;
    handledAt: string;
  };
}

export interface ReviewQuery {
  status: "pending";
  type?: string;
  category?: string;
  cursor?: string;
}

export async function submitPostReport(
  postId: string,
  input: { type: ReportType; detail: string },
  csrfToken: string,
): Promise<SubmitReportResponse> {
  return requestJson<SubmitReportResponse>(
    `/api/posts/${encodeURIComponent(postId)}/reports`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": csrfToken,
      },
      body: JSON.stringify(input),
    },
  );
}

export async function getReviewQueue(
  query: ReviewQuery,
  signal?: AbortSignal,
): Promise<ReviewQueueResponse> {
  const params = new URLSearchParams({ status: query.status });
  if (query.type) params.set("type", query.type);
  if (query.category) params.set("category", query.category);
  if (query.cursor) params.set("cursor", query.cursor);

  return requestJson<ReviewQueueResponse>(`/api/admin/review?${params.toString()}`, {
    method: "GET",
    signal,
  });
}

export async function decideReviewItem(
  reviewId: string,
  input: { decision: "approve" | "reject"; note?: string },
  csrfToken: string,
): Promise<ReviewDecisionResponse> {
  return requestJson<ReviewDecisionResponse>(
    `/api/admin/review/${encodeURIComponent(reviewId)}/decision`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": csrfToken,
      },
      body: JSON.stringify(input),
    },
  );
}
