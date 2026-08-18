import { apiErrorFromResponse, requestJson } from "./api";

export interface AvatarResponse {
  avatar: {
    uploadId: string;
    avatarUrl: string;
  };
}

export async function bindProfileAvatar(
  uploadId: string,
  csrfToken: string,
): Promise<AvatarResponse> {
  return requestJson<AvatarResponse>("/api/profile/avatar", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-CSRF-Token": csrfToken,
    },
    body: JSON.stringify({ uploadId }),
  });
}

export async function removeProfileAvatar(csrfToken: string): Promise<void> {
  const response = await fetch("/api/profile/avatar", {
    method: "DELETE",
    credentials: "same-origin",
    headers: { "X-CSRF-Token": csrfToken },
  });
  if (!response.ok) {
    throw await apiErrorFromResponse(response);
  }
}
