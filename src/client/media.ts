import { apiErrorFromResponse, requestJson } from "./api";
import type { OptimizedImage, OptimizedImageObject } from "./imageOptimization";
import { isMediaBindingId } from "./pendingMediaBindings";

export interface UploadObjectInput {
  contentType: OptimizedImageObject["contentType"];
  bytes: number;
  checksumSha256: string;
  width: number;
  height: number;
}

export interface SignedPutRequest {
  url: string;
  method: "PUT";
  headers: {
    "content-type": OptimizedImageObject["contentType"];
    "x-amz-checksum-sha256": string;
  };
  expiresInSeconds: number;
}

export interface AuthorizedUpload {
  uploadId: string;
  main: SignedPutRequest;
  thumbnail?: SignedPutRequest;
}

export interface AuthorizeUploadsResponse {
  reservationId: string;
  expiresAt: number;
  capacityWarning: boolean;
  quota: {
    dailyLimitBytes: number;
    dailyRemainingBytes: number;
    siteRemainingBytes: number;
  };
  uploads: AuthorizedUpload[];
}

export interface FinalizeUploadsResponse {
  reservationId: string;
  state: "uploaded";
  uploads: Array<{ uploadId: string }>;
}

export interface SignedObjectUpload {
  request: SignedPutRequest;
  blob: Blob;
}

export class DirectUploadError extends Error {
  readonly status: number | null;

  constructor(status: number | null) {
    super(status === null ? "R2_CORS_OR_NETWORK_ERROR" : `R2_UPLOAD_FAILED_${status}`);
    this.name = "DirectUploadError";
    this.status = status;
  }
}

function objectInput(value: OptimizedImageObject): UploadObjectInput {
  return {
    contentType: value.contentType,
    bytes: value.bytes,
    checksumSha256: value.checksumSha256,
    width: value.width,
    height: value.height,
  };
}

export async function authorizeUploads(
  images: readonly OptimizedImage[],
  csrfToken: string,
): Promise<AuthorizeUploadsResponse> {
  return requestJson<AuthorizeUploadsResponse>("/api/uploads/authorize", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-CSRF-Token": csrfToken,
    },
    body: JSON.stringify({
      uploads: images.map((image) => ({
        filename: image.filename,
        main: objectInput(image.main),
        thumbnail: objectInput(image.thumbnail),
      })),
    }),
  });
}

export async function putSignedObject(
  request: SignedPutRequest,
  blob: Blob,
): Promise<void> {
  let response: Response;
  try {
    response = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: blob,
      credentials: "omit",
      mode: "cors",
    });
  } catch {
    throw new DirectUploadError(null);
  }
  if (!response.ok) throw new DirectUploadError(response.status);
}

export async function putSignedObjects(
  objects: readonly SignedObjectUpload[],
  onSettled?: (settled: number, total: number) => void,
): Promise<void> {
  let settled = 0;
  const results = await Promise.allSettled(objects.map(async (object) => {
    try {
      await putSignedObject(object.request, object.blob);
    } finally {
      settled += 1;
      onSettled?.(settled, objects.length);
    }
  }));
  const firstRejected = results.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (firstRejected) throw firstRejected.reason;
}

export function recognizableAuthorizedUploadIds(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  const uploads = (value as { uploads?: unknown }).uploads;
  if (!Array.isArray(uploads)) return [];
  return uploads.flatMap((upload) => {
    if (!upload || typeof upload !== "object") return [];
    const uploadId = (upload as { uploadId?: unknown }).uploadId;
    return isMediaBindingId(uploadId) ? [uploadId] : [];
  });
}

export async function finalizeUploads(
  reservationId: string,
  csrfToken: string,
): Promise<FinalizeUploadsResponse> {
  return requestJson<FinalizeUploadsResponse>("/api/uploads/finalize", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-CSRF-Token": csrfToken,
    },
    body: JSON.stringify({ reservationId }),
  });
}

export async function bindUpload(
  uploadId: string,
  topicId: string,
  postId: string,
  csrfToken: string,
): Promise<void> {
  await requestJson<unknown>("/api/uploads/bind", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-CSRF-Token": csrfToken,
    },
    body: JSON.stringify({ uploadId, topicId, postId }),
  });
}

export async function deleteTemporaryUpload(
  uploadId: string,
  csrfToken: string,
): Promise<void> {
  const response = await fetch(`/api/uploads/${encodeURIComponent(uploadId)}`, {
    method: "DELETE",
    credentials: "same-origin",
    headers: { "X-CSRF-Token": csrfToken },
  });
  if (!response.ok) throw await apiErrorFromResponse(response);
}

export async function cleanupTemporaryUploads(
  uploadIds: readonly string[],
  csrfToken: string,
): Promise<void> {
  await Promise.allSettled(uploadIds.map((uploadId) => deleteTemporaryUpload(uploadId, csrfToken)));
}
