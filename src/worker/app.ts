import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
import type { AppEnv } from "@/worker/env";
import { readRequestIdentity, verifyCsrf } from "@/worker/auth/session";
import systemRoutes from "@/worker/routes/system";
import forumRoutes from "@/worker/routes/forum";
import authRoutes from "@/worker/routes/auth";
import passkeyRoutes from "@/worker/routes/passkeys";
import uploadRoutes from "@/worker/routes/uploads";
import adminRoutes from "@/worker/routes/admin";
import interactionRoutes from "@/worker/routes/interactions";
import moderationRoutes from "@/worker/routes/moderation";
import notificationRoutes from "@/worker/routes/notifications";
import activityRoutes from "@/worker/routes/activity";
import adminTrustRoutes from "@/worker/routes/admin-trust";
import adminInviteRoutes from "@/worker/routes/admin-invites";
import profileRoutes from "@/worker/routes/profile";
import adminManagementRoutes from "@/worker/routes/admin-management";
import { enforceMaintenanceMode } from "@/worker/middleware/maintenance";

const app = new Hono<AppEnv>();

app.use("*", async (context, next) => {
  const requestId = crypto.randomUUID();
  context.set("requestId", requestId);
  context.header("x-request-id", requestId);
  await next();
});

app.use(
  "*",
  secureHeaders({
    contentSecurityPolicy: {
      defaultSrc: ["'self'"],
      baseUri: ["'none'"],
      connectSrc: ["'self'", "https://*.r2.cloudflarestorage.com"],
      fontSrc: ["'self'", "data:"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
      frameSrc: ["https://challenges.cloudflare.com"],
      imgSrc: ["'self'", "data:", "blob:", "https:"],
      objectSrc: ["'none'"],
      scriptSrc: ["'self'", "https://challenges.cloudflare.com"],
      styleSrc: ["'self'", "'unsafe-inline'"],
    },
    strictTransportSecurity:
      "max-age=31536000; includeSubDomains; preload",
    referrerPolicy: "strict-origin-when-cross-origin",
  }),
);

app.use("/api/*", async (context, next) => {
  context.header("cache-control", "private, no-store");
  context.header("vary", "Cookie");

  const identity = await readRequestIdentity(context);
  context.set("identity", identity);
  const method = context.req.method.toUpperCase();
  if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
    const requestOrigin = context.req.header("origin");
    let allowedOrigin: string;
    try {
      allowedOrigin = new URL(context.env.APP_ORIGIN).origin;
    } catch {
      return context.json({ error: { code: "SERVER_MISCONFIGURED" } }, 503);
    }
    if (requestOrigin !== allowedOrigin) {
      return context.json({ error: { code: "INVALID_REQUEST_ORIGIN" } }, 403);
    }

    if (identity.session && !(await verifyCsrf(context, identity.session))) {
      return context.json({ error: { code: "INVALID_CSRF_TOKEN" } }, 403);
    }
  }

  await next();
});

app.use("/api/*", enforceMaintenanceMode);

app.route("/api", systemRoutes);
app.route("/api", forumRoutes);
app.route("/api/auth", authRoutes);
app.route("/api/auth", passkeyRoutes);
app.route("/api", uploadRoutes);
app.route("/api", adminRoutes);
app.route("/api", interactionRoutes);
app.route("/api", moderationRoutes);
app.route("/api", notificationRoutes);
app.route("/api", activityRoutes);
app.route("/api", adminTrustRoutes);
app.route("/api", adminInviteRoutes);
app.route("/api", profileRoutes);
app.route("/api", adminManagementRoutes);

app.notFound((context) =>
  context.json({ error: { code: "NOT_FOUND" } }, 404),
);

app.onError((error, context) => {
  // Keep the public response stable and avoid logging request bodies or secrets.
  console.error("request_failed", {
    requestId: context.get("requestId"),
    name: error.name,
  });
  return context.json({ error: { code: "INTERNAL_ERROR" } }, 500);
});

export default app;
