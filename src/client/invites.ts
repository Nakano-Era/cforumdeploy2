import { requestJson } from "./api";

export type AdminInviteStatus = "active" | "exhausted" | "expired" | "revoked";

export interface AdminInvite {
  id: string;
  status: AdminInviteStatus;
  maxUses: number;
  usedCount: number;
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  createdBy: {
    id: string;
    username: string;
    displayName: string;
  };
}

export interface AdminInviteListResponse {
  items: AdminInvite[];
  nextCursor: string | null;
}

export interface AdminInviteCreateResponse {
  invite: AdminInvite;
  token: string;
}

export async function getAdminInvites(
  cursor?: string,
  signal?: AbortSignal,
): Promise<AdminInviteListResponse> {
  const params = new URLSearchParams();
  if (cursor) params.set("cursor", cursor);
  const suffix = params.size > 0 ? `?${params.toString()}` : "";
  return requestJson<AdminInviteListResponse>(`/api/admin/invites${suffix}`, {
    method: "GET",
    signal,
  });
}

export async function createSingleUseInvite(
  csrfToken: string,
): Promise<AdminInviteCreateResponse> {
  return requestJson<AdminInviteCreateResponse>("/api/admin/invites", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-CSRF-Token": csrfToken,
    },
    body: JSON.stringify({ maxUses: 1 }),
  });
}

export async function revokeAdminInvite(
  inviteId: string,
  csrfToken: string,
): Promise<{ invite: AdminInvite }> {
  return requestJson<{ invite: AdminInvite }>(
    `/api/admin/invites/${encodeURIComponent(inviteId)}`,
    {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": csrfToken,
      },
      body: JSON.stringify({ revoked: true }),
    },
  );
}
