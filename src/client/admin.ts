import { requestJson, type RegistrationMode } from "./api";
import type { TrustLevel } from "./feed";

export interface AdminSettings {
  siteName?: string;
  siteDescription?: string;
  registrationMode?: RegistrationMode;
  registrationFrozen?: boolean;
  inviteRequiresApproval?: boolean;
  maintenanceMode?: boolean;
  lv0FirstTopicsReviewCount?: number;
  lv0FirstRepliesReviewCount?: number;
}

export type AdminUserRole = "member" | "moderator" | "admin";
export type AdminUserStatus =
  | "pending"
  | "active"
  | "silenced"
  | "suspended"
  | "deleted";

export interface AdminUser {
  id: string;
  username: string;
  displayName: string;
  email: string | null;
  trustLevel: TrustLevel;
  levelLocked: boolean;
  role: AdminUserRole;
  status: AdminUserStatus;
  nextLevelReviewAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AdminUserListResponse {
  items: AdminUser[];
  nextCursor: string | null;
}

export interface AdminCategory {
  id: string;
  slug: string;
  name: string;
  description: string;
  color: string;
  aclMode: "open" | "restricted";
  minViewLevel: TrustLevel;
  minCreateLevel: TrustLevel;
  minReplyLevel: TrustLevel;
  allowedTopicMinLevelMax: TrustLevel;
  allowImages: boolean;
  requireTopicApproval: boolean;
  requireReplyApproval: boolean;
  state: "active" | "archived" | "deleted";
  position: number;
  createdAt: string;
  updatedAt: string;
}

export interface AdminCategoryListResponse {
  items: AdminCategory[];
}

export interface CreateAdminCategoryInput {
  slug: string;
  name: string;
  description: string;
  color: string;
  aclMode: "open" | "restricted";
  minViewLevel: TrustLevel;
  minCreateLevel: TrustLevel;
  minReplyLevel: TrustLevel;
  allowedTopicMinLevelMax: TrustLevel;
  allowImages: boolean;
}

export async function getAdminSettings(
  signal?: AbortSignal,
): Promise<{ settings: AdminSettings }> {
  return requestJson<{ settings: AdminSettings }>("/api/admin/settings", {
    method: "GET",
    signal,
  });
}

export async function updateAdminSettings(
  input: AdminSettings,
  csrfToken: string,
): Promise<{ settings: AdminSettings }> {
  return requestJson<{ settings: AdminSettings }>("/api/admin/settings", {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      "X-CSRF-Token": csrfToken,
    },
    body: JSON.stringify(input),
  });
}

export async function getAdminUsers(
  input: { query?: string; cursor?: string } = {},
  signal?: AbortSignal,
): Promise<AdminUserListResponse> {
  const params = new URLSearchParams();
  if (input.query) params.set("q", input.query);
  if (input.cursor) params.set("cursor", input.cursor);
  const suffix = params.size > 0 ? `?${params.toString()}` : "";
  return requestJson<AdminUserListResponse>(`/api/admin/users${suffix}`, {
    method: "GET",
    signal,
  });
}

export async function updateAdminUser(
  userId: string,
  input: Partial<Pick<AdminUser, "trustLevel" | "levelLocked" | "role">>,
  csrfToken: string,
): Promise<{ user: AdminUser }> {
  return requestJson<{ user: AdminUser }>(
    `/api/admin/users/${encodeURIComponent(userId)}`,
    {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": csrfToken,
      },
      body: JSON.stringify(input),
    },
  );
}

export async function getAdminCategories(
  signal?: AbortSignal,
): Promise<AdminCategoryListResponse> {
  return requestJson<AdminCategoryListResponse>("/api/admin/categories", {
    method: "GET",
    signal,
  });
}

export async function createAdminCategory(
  input: CreateAdminCategoryInput,
  csrfToken: string,
): Promise<{ category: AdminCategory }> {
  return requestJson<{ category: AdminCategory }>("/api/admin/categories", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-CSRF-Token": csrfToken,
    },
    body: JSON.stringify(input),
  });
}
