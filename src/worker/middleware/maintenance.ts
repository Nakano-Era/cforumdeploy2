import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "@/worker/env";
import { isMaintenanceModeEnabled } from "@/worker/repositories/settings";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// These mutations are required to install the site, let an administrator sign
// in and recover it, or let any signed-in user end a session safely. Account
// creation and Passkey registration intentionally remain blocked.
const RECOVERY_MUTATIONS = new Set([
  "POST /api/bootstrap",
  "POST /api/auth/email/request-code",
  "POST /api/auth/email/verify",
  "POST /api/auth/email/consume-login",
  "POST /api/auth/passkeys/authenticate/options",
  "POST /api/auth/passkeys/authenticate/verify",
  "POST /api/auth/logout",
  "POST /api/auth/logout-all",
]);

function normalizedPath(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

export function isMaintenanceRecoveryMutation(
  method: string,
  path: string,
): boolean {
  return RECOVERY_MUTATIONS.has(
    `${method.toUpperCase()} ${normalizedPath(path)}`,
  );
}

export const enforceMaintenanceMode: MiddlewareHandler<AppEnv> = async (
  context,
  next,
) => {
  const method = context.req.method.toUpperCase();
  if (
    SAFE_METHODS.has(method) ||
    isMaintenanceRecoveryMutation(method, context.req.path)
  ) {
    await next();
    return;
  }

  const identity = context.get("identity");
  if (
    identity.session &&
    identity.viewer.userId &&
    identity.viewer.role === "admin" &&
    identity.viewer.status === "active"
  ) {
    await next();
    return;
  }

  if (await isMaintenanceModeEnabled(context.env.CFORUM_DB)) {
    return context.json(
      { error: { code: "SITE_MAINTENANCE" } },
      503,
    );
  }

  await next();
};
