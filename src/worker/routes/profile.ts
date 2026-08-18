import { Hono, type Context } from "hono";
import type { AppEnv } from "@/worker/env";
import { MediaError } from "@/worker/media/errors";
import {
  bindAvatarUpload,
  removeAvatarUpload,
  serveAvatar,
} from "@/worker/media/lifecycle";
import {
  bindAvatarSchema,
  uploadIdSchema,
} from "@/worker/media/schema";

const router = new Hono<AppEnv>();

function mediaFailure(context: Context<AppEnv>, error: unknown) {
  if (error instanceof MediaError) {
    return context.json({ error: { code: error.code } }, error.status);
  }
  throw error;
}

router.post("/profile/avatar", async (context) => {
  const parsed = bindAvatarSchema.safeParse(
    await context.req.json().catch(() => null),
  );
  if (!parsed.success) {
    return context.json({ error: { code: "INVALID_UPLOAD_REQUEST" } }, 422);
  }
  try {
    const result = await bindAvatarUpload(
      context.env,
      context.get("identity").viewer,
      parsed.data.uploadId,
      context.get("requestId"),
    );
    return context.json({ avatar: result });
  } catch (error) {
    return mediaFailure(context, error);
  }
});

router.delete("/profile/avatar", async (context) => {
  try {
    await removeAvatarUpload(
      context.env,
      context.get("identity").viewer,
      context.get("requestId"),
    );
    return context.body(null, 204);
  } catch (error) {
    return mediaFailure(context, error);
  }
});

async function avatarResponse(context: Context<AppEnv>) {
  const parsedId = uploadIdSchema.safeParse(context.req.param("uploadId"));
  if (!parsedId.success) {
    return context.json({ error: { code: "MEDIA_NOT_FOUND" } }, 404);
  }
  try {
    return await serveAvatar(
      context.env,
      parsedId.data,
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

router.get("/avatars/:uploadId", avatarResponse);
router.on("HEAD", "/avatars/:uploadId", avatarResponse);

export default router;
