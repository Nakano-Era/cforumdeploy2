import { Hono, type Context } from "hono";
import type { AppEnv } from "@/worker/env";
import { MediaError } from "@/worker/media/errors";
import { bindUpload, serveMedia } from "@/worker/media/lifecycle";
import {
  authorizeUploads,
  deleteTemporaryUpload,
  finalizeUploads,
} from "@/worker/media/service";
import {
  authorizeUploadsSchema,
  bindUploadSchema,
  finalizeUploadsSchema,
  mediaVariantSchema,
  uploadIdSchema,
} from "@/worker/media/schema";

const router = new Hono<AppEnv>();

function activeViewer(context: Context<AppEnv>) {
  const viewer = context.get("identity").viewer;
  if (!viewer.userId) {
    throw new MediaError("AUTHENTICATION_REQUIRED", 401);
  }
  if (viewer.status !== "active") {
    throw new MediaError("ACCOUNT_INACTIVE", 403);
  }
  return {
    userId: viewer.userId,
    trustLevel: viewer.trustLevel ?? 0,
  };
}

router.post("/uploads/authorize", async (context) => {
  try {
    const viewer = activeViewer(context);
    let body: unknown;
    try {
      body = await context.req.json();
    } catch {
      throw new MediaError("INVALID_UPLOAD_REQUEST", 422);
    }
    const parsed = authorizeUploadsSchema.safeParse(body);
    if (!parsed.success) {
      throw new MediaError("INVALID_UPLOAD_REQUEST", 422);
    }
    const result = await authorizeUploads(context.env, viewer, parsed.data);
    return context.json(result, 201);
  } catch (error) {
    if (error instanceof MediaError) {
      return context.json({ error: { code: error.code } }, error.status);
    }
    throw error;
  }
});

router.post("/uploads/finalize", async (context) => {
  try {
    const viewer = activeViewer(context);
    let body: unknown;
    try {
      body = await context.req.json();
    } catch {
      throw new MediaError("INVALID_UPLOAD_REQUEST", 422);
    }
    const parsed = finalizeUploadsSchema.safeParse(body);
    if (!parsed.success) {
      throw new MediaError("INVALID_UPLOAD_REQUEST", 422);
    }
    return context.json(
      await finalizeUploads(
        context.env,
        viewer.userId,
        parsed.data.reservationId,
      ),
    );
  } catch (error) {
    if (error instanceof MediaError) {
      return context.json({ error: { code: error.code } }, error.status);
    }
    throw error;
  }
});

router.post("/uploads/bind", async (context) => {
  try {
    activeViewer(context);
    let body: unknown;
    try {
      body = await context.req.json();
    } catch {
      throw new MediaError("INVALID_UPLOAD_REQUEST", 422);
    }
    const parsed = bindUploadSchema.safeParse(body);
    if (!parsed.success) {
      throw new MediaError("INVALID_UPLOAD_REQUEST", 422);
    }
    return context.json(
      await bindUpload(
        context.env,
        context.get("identity").viewer,
        parsed.data,
      ),
    );
  } catch (error) {
    if (error instanceof MediaError) {
      return context.json({ error: { code: error.code } }, error.status);
    }
    throw error;
  }
});

router.delete("/uploads/:id", async (context) => {
  try {
    const viewer = activeViewer(context);
    const parsedId = uploadIdSchema.safeParse(context.req.param("id"));
    if (!parsedId.success) {
      throw new MediaError("UPLOAD_NOT_FOUND", 404);
    }
    await deleteTemporaryUpload(context.env, viewer.userId, parsedId.data);
    return context.body(null, 204);
  } catch (error) {
    if (error instanceof MediaError) {
      return context.json({ error: { code: error.code } }, error.status);
    }
    throw error;
  }
});

async function mediaResponse(context: Context<AppEnv>) {
  try {
    const parsedId = uploadIdSchema.safeParse(
      context.req.param("uploadId"),
    );
    const parsedVariant = mediaVariantSchema.safeParse(
      context.req.param("variant") || "main",
    );
    if (!parsedId.success || !parsedVariant.success) {
      throw new MediaError("MEDIA_NOT_FOUND", 404);
    }
    return await serveMedia(
      context.env,
      context.get("identity").viewer,
      parsedId.data,
      parsedVariant.data,
      context.req.method === "HEAD" ? "HEAD" : "GET",
      context.req.header("if-none-match"),
    );
  } catch (error) {
    if (error instanceof MediaError) {
      return context.json({ error: { code: "MEDIA_NOT_FOUND" } }, 404);
    }
    throw error;
  }
}

router.get("/media/:uploadId", mediaResponse);
router.get("/media/:uploadId/:variant", mediaResponse);
router.on("HEAD", "/media/:uploadId", mediaResponse);
router.on("HEAD", "/media/:uploadId/:variant", mediaResponse);

export default router;
