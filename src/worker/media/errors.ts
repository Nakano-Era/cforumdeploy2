export type MediaErrorCode =
  | "AUTHENTICATION_REQUIRED"
  | "ACCOUNT_INACTIVE"
  | "INVALID_UPLOAD_REQUEST"
  | "MEDIA_SIGNING_UNAVAILABLE"
  | "UPLOAD_DAILY_QUOTA_EXCEEDED"
  | "UPLOAD_SITE_CAPACITY_EXCEEDED"
  | "UPLOAD_RESERVATION_NOT_FOUND"
  | "UPLOAD_RESERVATION_EXPIRED"
  | "UPLOAD_RESERVATION_UNAVAILABLE"
  | "UPLOAD_VALIDATION_FAILED"
  | "UPLOAD_NOT_FOUND"
  | "UPLOAD_NOT_DELETABLE"
  | "UPLOAD_NOT_BINDABLE"
  | "MEDIA_MOVE_FAILED"
  | "MEDIA_NOT_FOUND";

export type MediaErrorStatus = 401 | 403 | 404 | 409 | 410 | 422 | 429 | 503;

export class MediaError extends Error {
  readonly code: MediaErrorCode;
  readonly status: MediaErrorStatus;

  constructor(code: MediaErrorCode, status: MediaErrorStatus) {
    super(code);
    this.name = "MediaError";
    this.code = code;
    this.status = status;
  }
}
