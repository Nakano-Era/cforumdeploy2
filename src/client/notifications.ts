import { requestJson } from "./api";

export interface NotificationActor {
  id: string;
  username: string;
  displayName: string;
}

export interface ForumNotification {
  id: string;
  kind: string;
  actor: NotificationActor | null;
  topicId: string | null;
  postId: string | null;
  targetAvailable: boolean;
  data: Record<string, string | number | boolean>;
  createdAt: string;
  readAt: string | null;
}

export interface NotificationsResponse {
  notifications: ForumNotification[];
  unreadCount: number;
  nextCursor: string | null;
}

export interface ReadNotificationsResponse {
  updated: number;
  unreadCount: number;
}

export async function getNotifications(
  cursor?: string,
  signal?: AbortSignal,
): Promise<NotificationsResponse> {
  const params = new URLSearchParams();
  if (cursor) params.set("cursor", cursor);
  const suffix = params.size > 0 ? `?${params.toString()}` : "";
  return requestJson<NotificationsResponse>(`/api/notifications${suffix}`, {
    method: "GET",
    signal,
  });
}

export async function markNotificationsRead(
  input: { ids: string[] } | { all: true },
  csrfToken: string,
): Promise<ReadNotificationsResponse> {
  return requestJson<ReadNotificationsResponse>("/api/notifications/read", {
    method: "POST",
    headers: {
  "Content-Type": "application/json",
      "X-CSRF-Token": csrfToken,
    },
    body: JSON.stringify(input),
  });
}
