export function avatarUrl(uploadId: string | null | undefined): string | null {
  return uploadId
    ? `/api/avatars/${encodeURIComponent(uploadId)}`
    : null;
}
