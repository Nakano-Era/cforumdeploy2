import { useEffect, useState, type ChangeEvent, type FormEvent } from "react";
import { ApiRequestError, isSiteMaintenanceError } from "./api";
import type { AuthUser } from "./auth";
import {
  describeImageOptimizationError,
  optimizeAvatarImage,
  type OptimizedImage,
} from "./imageOptimization";
import {
  authorizeUploads,
  cleanupTemporaryUploads,
  finalizeUploads,
  putSignedObjects,
  recognizableAuthorizedUploadIds,
} from "./media";
import { bindProfileAvatar, removeProfileAvatar } from "./profile";

interface ProfileDialogProps {
  csrfToken: string | null;
  user: AuthUser;
  onAuthenticationRequired: () => void;
  onBusyChange: (busy: boolean) => void;
  onClose: () => void;
  onUpdated: (avatarUrl: string | null) => void;
}

type AvatarStage = "idle" | "optimizing" | "authorizing" | "uploading" | "finalizing" | "saving" | "removing";

function stageLabel(stage: AvatarStage): string {
  switch (stage) {
    case "optimizing": return "正在安全处理图片…";
    case "authorizing": return "正在申请上传许可…";
    case "uploading": return "正在上传头像…";
    case "finalizing": return "正在校验图片…";
    case "saving": return "正在保存头像…";
    case "removing": return "正在移除头像…";
    default: return "保存新头像";
  }
}

function avatarFailure(error: unknown): string {
  if (isSiteMaintenanceError(error)) return "站点正在维护，暂时不能修改头像。";
  if (error instanceof ApiRequestError) {
    if (error.status === 401) return "登录状态已经失效，请重新登录。";
    if (error.code === "INVALID_CSRF_TOKEN") return "会话安全令牌已失效，请刷新后重试。";
    if (error.code === "UPLOAD_DAILY_QUOTA_EXCEEDED") return "今天的图片上传额度已经用完。";
    if (error.code === "UPLOAD_SITE_CAPACITY_EXCEEDED") return "站点媒体空间暂时不足，请稍后再试。";
    if (error.code === "UPLOAD_NOT_BINDABLE") return "这张图片已失效，请重新选择后上传。";
  }
  return "头像没有保存成功，请检查网络后再试。";
}

export default function ProfileDialog({
  csrfToken,
  user,
  onAuthenticationRequired,
  onBusyChange,
  onClose,
  onUpdated,
}: ProfileDialogProps) {
  const [image, setImage] = useState<OptimizedImage | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [stage, setStage] = useState<AvatarStage>("idle");
  const [error, setError] = useState("");
  const busy = stage !== "idle";

  useEffect(() => {
    onBusyChange(busy);
  }, [busy, onBusyChange]);

  useEffect(
    () => () => onBusyChange(false),
    [onBusyChange],
  );

  useEffect(() => () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
  }, [previewUrl]);

  const selectImage = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setError("");
    setStage("optimizing");
    try {
      const optimized = await optimizeAvatarImage(file);
      setPreviewUrl((current) => {
        if (current) URL.revokeObjectURL(current);
        return URL.createObjectURL(optimized.main.blob);
      });
      setImage(optimized);
    } catch (optimizationError) {
      setImage(null);
      setError(describeImageOptimizationError(optimizationError));
    } finally {
      setStage("idle");
    }
  };

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!image || busy) return;
    if (!csrfToken) {
      setError("会话安全令牌不可用，请刷新页面后重试。");
      return;
    }
    setError("");
    let uploadIds: string[] = [];
    let bound = false;
    try {
      setStage("authorizing");
      const authorization = await authorizeUploads([image], csrfToken);
      uploadIds = recognizableAuthorizedUploadIds(authorization);
      const remote = authorization.uploads[0];
      if (uploadIds.length !== 1 || !remote?.thumbnail) {
        throw new Error("UPLOAD_RESPONSE_MISMATCH");
      }
      setStage("uploading");
      await putSignedObjects([
        { request: remote.main, blob: image.main.blob },
        { request: remote.thumbnail, blob: image.thumbnail.blob },
      ]);
      setStage("finalizing");
      await finalizeUploads(authorization.reservationId, csrfToken);
      setStage("saving");
      const response = await bindProfileAvatar(uploadIds[0]!, csrfToken);
      bound = true;
      onUpdated(response.avatar.avatarUrl);
    } catch (requestError) {
      if (!bound && uploadIds.length > 0) {
        await cleanupTemporaryUploads(uploadIds, csrfToken);
      }
      setError(avatarFailure(requestError));
      if (requestError instanceof ApiRequestError && requestError.status === 401) {
        onAuthenticationRequired();
      }
    } finally {
      setStage("idle");
    }
  };

  const remove = async () => {
    if (busy || !user.avatarUrl) return;
    if (!csrfToken) {
      setError("会话安全令牌不可用，请刷新页面后重试。");
      return;
    }
    setError("");
    setStage("removing");
    try {
      await removeProfileAvatar(csrfToken);
      onUpdated(null);
    } catch (requestError) {
      setError(avatarFailure(requestError));
      if (requestError instanceof ApiRequestError && requestError.status === 401) {
        onAuthenticationRequired();
      }
    } finally {
      setStage("idle");
    }
  };

  const shownAvatar = previewUrl ?? user.avatarUrl ?? null;
  return (
    <div className="modal-backdrop" onMouseDown={(event) => !busy && event.target === event.currentTarget && onClose()}>
      <section aria-labelledby="profile-title" aria-modal="true" className="modal-card profile-dialog" role="dialog">
        <button aria-label="关闭头像设置" className="modal-close" disabled={busy} onClick={onClose} type="button">×</button>
        <p className="eyebrow">个人设置</p>
        <h2 id="profile-title">设置头像</h2>
        <p className="profile-intro">上传一张能代表你的图片。图片会先在本地移除元数据并压缩，再安全上传。</p>
        <form onSubmit={(event) => void save(event)}>
          <div className="profile-avatar-preview">
            {shownAvatar
              ? <img alt={`${user.displayName} 的头像预览`} src={shownAvatar} />
              : <span aria-hidden="true">{[...user.displayName][0] ?? "我"}</span>}
          </div>
          <label className={busy ? "profile-avatar-picker is-disabled" : "profile-avatar-picker"}>
            <input accept="image/jpeg,image/png,image/webp" disabled={busy} onChange={(event) => void selectImage(event)} type="file" />
            <strong>{image ? "重新选择图片" : "选择图片"}</strong>
            <small>支持 JPEG、PNG、WebP；原图不超过 12 MB</small>
          </label>
          {error && <div className="compose-error" role="alert"><span aria-hidden="true">!</span>{error}</div>}
          <div className="modal-actions profile-actions">
            {user.avatarUrl && <button className="button button-quiet profile-remove" disabled={busy} onClick={() => void remove()} type="button">{stage === "removing" ? stageLabel(stage) : "移除当前头像"}</button>}
            <button className="button button-secondary" disabled={busy} onClick={onClose} type="button">取消</button>
            <button className="button button-primary" disabled={busy || !image} type="submit">{stageLabel(stage)}</button>
          </div>
        </form>
      </section>
    </div>
  );
}
