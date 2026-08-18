export type RegistrationMode = "open" | "approval" | "invite_only";

export interface BootstrapStatusResponse {
  installationRequired: boolean;
}

export interface BootstrapRequest {
  siteName: string;
  username: string;
  displayName: string;
  email: string;
  registrationMode: RegistrationMode;
}

export interface BootstrapSuccessResponse {
  user: {
    id: string;
    username: string;
    displayName: string;
    role: "admin";
    trustLevel: 4;
  };
  csrfToken: string;
}

export interface PublicSiteConfig {
  siteName: string;
  siteDescription: string;
  registrationMode: RegistrationMode;
  registrationFrozen: boolean;
  maintenanceMode: boolean;
  turnstileSiteKey: string | null;
}

interface ApiErrorPayload {
  error?: {
    code?: string;
    fields?: Record<string, string[]>;
  };
}

export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: string;
  readonly fields?: Record<string, string[]>;

  constructor(status: number, payload?: ApiErrorPayload) {
    const code = payload?.error?.code ?? "REQUEST_FAILED";
    super(`API request failed (${status}, ${code})`);
    this.name = "ApiRequestError";
    this.status = status;
    this.code = code;
    this.fields = payload?.error?.fields;
  }
}

export function isSiteMaintenanceError(error: unknown): error is ApiRequestError {
  return error instanceof ApiRequestError && error.status === 503 && error.code === "SITE_MAINTENANCE";
}

export async function apiErrorFromResponse(response: Response): Promise<ApiRequestError> {
  const payload = (await response.json().catch(() => undefined)) as
    | ApiErrorPayload
    | undefined;
  return new ApiRequestError(response.status, payload);
}

export async function requestJson<T>(
  path: string,
  init: RequestInit,
): Promise<T> {
  const response = await fetch(path, {
    credentials: "same-origin",
    ...init,
    headers: {
      Accept: "application/json",
      ...init.headers,
    },
  });
  if (!response.ok) throw await apiErrorFromResponse(response);
  return (await response.json()) as T;
}

export async function getBootstrapStatus(
  signal?: AbortSignal,
): Promise<BootstrapStatusResponse> {
  return requestJson<BootstrapStatusResponse>("/api/bootstrap/status", {
    method: "GET",
    signal,
  });
}

export async function getPublicSiteConfig(
  signal?: AbortSignal,
): Promise<PublicSiteConfig> {
  return requestJson<PublicSiteConfig>("/api/site", {
    method: "GET",
    signal,
  });
}

export async function bootstrapSite(
  input: BootstrapRequest,
  bootstrapSecret: string,
  signal?: AbortSignal,
): Promise<BootstrapSuccessResponse> {
  return requestJson<BootstrapSuccessResponse>("/api/bootstrap", {
    method: "POST",
    headers: {
      Authorization: `Bootstrap ${bootstrapSecret}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(input),
    signal,
  });
}
