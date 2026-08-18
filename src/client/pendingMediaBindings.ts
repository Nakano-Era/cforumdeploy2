export interface PendingMediaBindJob {
  topicId: string;
  postId: string;
  uploadIds: string[];
}

export interface MediaBindingStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const STORAGE_KEY_PREFIX = "cforum.pending-media-bind.v1:";
const MEDIA_BINDING_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isMediaBindingId(value: unknown): value is string {
  return typeof value === "string" && MEDIA_BINDING_ID.test(value);
}

export function pendingMediaBindStorageKey(userId: string): string | null {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(userId)) return null;
  return `${STORAGE_KEY_PREFIX}${userId}`;
}

function isPendingMediaBindJob(value: unknown): value is PendingMediaBindJob {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (
    keys.length !== 3 ||
    keys[0] !== "postId" ||
    keys[1] !== "topicId" ||
    keys[2] !== "uploadIds"
  ) {
    return false;
  }
  if (!isMediaBindingId(record.topicId) || !isMediaBindingId(record.postId)) {
    return false;
  }
  if (
    !Array.isArray(record.uploadIds) ||
    record.uploadIds.length < 1 ||
    record.uploadIds.length > 10 ||
    !record.uploadIds.every(isMediaBindingId) ||
    new Set(record.uploadIds).size !== record.uploadIds.length
  ) {
    return false;
  }
  return true;
}

function removeWithoutThrow(storage: MediaBindingStorage, key: string): void {
  try {
    storage.removeItem(key);
  } catch {
    // Storage can be unavailable in privacy modes. Binding still remains
    // retry-safe on the server and in the mounted component.
  }
}

export function loadPendingMediaBindJob(
  storage: MediaBindingStorage,
  userId: string,
): PendingMediaBindJob | null {
  const key = pendingMediaBindStorageKey(userId);
  if (!key) return null;
  let raw: string | null;
  try {
    raw = storage.getItem(key);
  } catch {
    return null;
  }
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isPendingMediaBindJob(parsed)) {
      removeWithoutThrow(storage, key);
      return null;
    }
    return {
      topicId: parsed.topicId,
      postId: parsed.postId,
      uploadIds: [...parsed.uploadIds],
    };
  } catch {
    removeWithoutThrow(storage, key);
    return null;
  }
}

export function savePendingMediaBindJob(
  storage: MediaBindingStorage,
  userId: string,
  job: PendingMediaBindJob,
): boolean {
  const key = pendingMediaBindStorageKey(userId);
  if (!key || !isPendingMediaBindJob(job)) return false;
  const persisted: PendingMediaBindJob = {
    topicId: job.topicId,
    postId: job.postId,
    uploadIds: [...job.uploadIds],
  };
  try {
    storage.setItem(key, JSON.stringify(persisted));
    return true;
  } catch {
    return false;
  }
}

export function clearPendingMediaBindJob(
  storage: MediaBindingStorage,
  userId: string,
): boolean {
  const key = pendingMediaBindStorageKey(userId);
  if (!key) return false;
  try {
    storage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}
