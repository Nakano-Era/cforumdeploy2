import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
} from "react";
import { ApiRequestError } from "./api";
import type { CategorySummary, TrustLevel } from "./feed";
import { createTopic, type CreateTopicResponse } from "./forum";
import {
  describeImageOptimizationError,
  optimizeImage,
  safeMarkdownAlt,
  type OptimizedImage,
} from "./imageOptimization";
import {
  authorizeUploads,
  bindUpload,
  cleanupTemporaryUploads,
  DirectUploadError,
  finalizeUploads,
  putSignedObjects,
  recognizableAuthorizedUploadIds,
} from "./media";
import {
  clearPendingMediaBindJob,
  loadPendingMediaBindJob,
  savePendingMediaBindJob,
  type PendingMediaBindJob,
} from "./pendingMediaBindings";

interface ComposeDialogProps {
  categories: CategorySummary[];
  csrfToken: string | null;
  maxTrustLevel: TrustLevel;
  onAuthenticationRequired: () => void;
  onClose: () => void;
  onCompleted: () => void;
  onTopicCreated: (response: CreateTopicResponse) => void;
  userId: string;
}

type DraftImage = {
  id: string;
  name: string;
  status: "optimizing" | "ready" | "error";
  image?: OptimizedImage;
  previewUrl?: string;
  alt: string;
  error?: string;
};

type SubmitStage = "idle" | "authorize" | "upload" | "finalize" | "topic" | "bind" | "bind_failed";

const RESTORED_BIND_MESSAGE = "主题已创建，勿重复发布；仍有图片等待绑定，可安全重试。";

function browserStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function loadStoredBindJob(userId: string): PendingMediaBindJob | null {
  const storage = browserStorage();
  return storage ? loadPendingMediaBindJob(storage, userId) : null;
}

function persistBindJob(userId: string, job: PendingMediaBindJob): boolean {
  const storage = browserStorage();
  return storage ? savePendingMediaBindJob(storage, userId, job) : false;
}

function clearStoredBindJob(userId: string): void {
  const storage = browserStorage();
  if (storage) clearPendingMediaBindJob(storage, userId);
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function uploadErrorMessage(error: unknown): string {
  if (error instanceof DirectUploadError) {
    return error.status === null
      ? "浏览器无法直传 R2，请检查桶的 CORS 规则与网络连接。"
      : error.status === 403
        ? "R2 拒绝了上传，预签名可能已过期或请求头不匹配，请重试。"
        : `R2 上传失败（HTTP ${error.status}），请稍后重试。`;
  }
  if (!(error instanceof ApiRequestError)) return "图片流程因网络异常中断，请稍后重试。";
  if (error.code === "SITE_MAINTENANCE") return "站点正在维护，暂时只开放阅读；已创建主题的绑定任务会保留，可稍后重试。";
  if (error.code === "INVALID_CSRF_TOKEN") return "会话安全令牌已失效，请重新登录后重试。";
  if (error.status === 401) return "登录状态已失效，请重新登录。";
  if (error.status === 403) return "当前账号或板块权限不允许上传图片。";
  if (error.code === "UPLOAD_DAILY_QUOTA_EXCEEDED") return "今日图片额度已用完，请明天再试或减少图片。";
  if (error.code === "UPLOAD_SITE_CAPACITY_EXCEEDED") return "站点媒体空间已满，暂时无法上传图片。";
  if (error.code === "MEDIA_SIGNING_UNAVAILABLE") return "R2 签名服务尚未配置好，请联系管理员。";
  if (error.code === "UPLOAD_VALIDATION_FAILED") return "R2 中的图片与本地校验信息不一致，请重新选择图片。";
  if (error.status === 410) return "上传许可已过期，请重新提交。";
  if (error.status === 409) return "上传暂存状态已变化，请重新提交。";
  if (error.status === 422) return "图片参数未通过服务器校验，请重新选择图片。";
  return "图片处理服务暂时不可用，请稍后重试。";
}

function topicErrorMessage(error: unknown): string {
  if (!(error instanceof ApiRequestError)) return "网络连接中断，主题尚未提交。";
  if (error.code === "SITE_MAINTENANCE") return "站点正在维护，暂时只开放阅读；主题没有提交。";
  if (error.status === 401) return "登录状态已失效，请重新登录。";
  if (error.code === "INVALID_CSRF_TOKEN") return "会话安全令牌已失效，请刷新页面后重试。";
  if (error.code === "ACTION_NOT_ALLOWED") return "你的等级或板块权限不允许这样发布。";
  if (error.code === "INVALID_INPUT") return "标题、正文或可见等级格式不正确。";
  return "主题没有成功提交，请稍后重试。";
}

function stageLabel(stage: SubmitStage, uploadProgress: string): string {
  if (stage === "authorize") return "正在申请上传许可…";
  if (stage === "upload") return uploadProgress || "正在直传 R2…";
  if (stage === "finalize") return "正在核验并完成暂存…";
  if (stage === "topic") return "图片已就绪，正在发布主题…";
  if (stage === "bind") return "主题已创建，正在绑定图片…";
  if (stage === "bind_failed") return "主题已创建，但仍有图片等待绑定";
  return "";
}

export default function ComposeDialog({
  categories,
  csrfToken,
  maxTrustLevel,
  onAuthenticationRequired,
  onClose,
  onCompleted,
  onTopicCreated,
  userId,
}: ComposeDialogProps) {
  const availableCategories = useMemo(() => categories.filter((item) => item.canCreate), [categories]);
  const [categoryId, setCategoryId] = useState(availableCategories[0]?.id ?? "");
  const [minViewLevel, setMinViewLevel] = useState<TrustLevel>(0);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [images, setImages] = useState<DraftImage[]>([]);
  const [busy, setBusy] = useState(false);
  const [pendingBind, setPendingBind] = useState<PendingMediaBindJob | null>(
    () => loadStoredBindJob(userId),
  );
  const [error, setError] = useState(() => pendingBind ? RESTORED_BIND_MESSAGE : "");
  const [warning, setWarning] = useState("");
  const [stage, setStage] = useState<SubmitStage>(() => pendingBind ? "bind_failed" : "idle");
  const [uploadProgress, setUploadProgress] = useState("");
  const previewUrls = useRef(new Set<string>());
  const cancelledIds = useRef(new Set<string>());
  const mounted = useRef(true);

  useEffect(() => () => {
    mounted.current = false;
    for (const url of previewUrls.current) URL.revokeObjectURL(url);
    previewUrls.current.clear();
  }, []);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [busy, onClose]);

  const category = availableCategories.find((item) => item.id === categoryId) ?? null;
  const levelMax = Math.min(maxTrustLevel, category?.allowedTopicMinLevelMax ?? 0) as TrustLevel;
  const optimizing = images.some((item) => item.status === "optimizing");
  const invalidImages = images.some((item) => item.status === "error");

  const changeCategory = (nextId: string) => {
    const next = availableCategories.find((item) => item.id === nextId);
    if (!next) return;
    if (!next.allowImages && images.length > 0) {
      setError("这个板块不允许图片；请先移除已选图片。 ");
      return;
    }
    setCategoryId(nextId);
    setMinViewLevel((current) => Math.min(current, maxTrustLevel, next.allowedTopicMinLevelMax) as TrustLevel);
    setError("");
  };

  const selectImages = async (event: ChangeEvent<HTMLInputElement>) => {
    const selected = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (!category?.allowImages || selected.length === 0) return;
    const remaining = 10 - images.length;
    if (selected.length > remaining) setError(`每篇主题最多 10 张图片，本次只处理前 ${remaining} 张。`);
    const files = selected.slice(0, Math.max(0, remaining));
    const drafts = files.map((file, index): DraftImage => ({
      id: `${Date.now()}-${index}-${Math.random().toString(36).slice(2)}`,
      name: file.name,
      status: "optimizing",
      alt: safeMarkdownAlt(file.name.replace(/\.[^.]+$/, "")),
    }));
    setImages((current) => [...current, ...drafts]);

    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      const draft = drafts[index];
      if (!file || !draft) continue;
      try {
        const image = await optimizeImage(file);
        const previewUrl = URL.createObjectURL(image.main.blob);
        if (!mounted.current || cancelledIds.current.has(draft.id)) {
          URL.revokeObjectURL(previewUrl);
          continue;
        }
        previewUrls.current.add(previewUrl);
        setImages((current) => current.map((item) => item.id === draft.id
          ? { ...item, status: "ready", image, previewUrl, alt: image.alt }
          : item));
      } catch (optimizationError) {
        if (!cancelledIds.current.has(draft.id)) {
          setImages((current) => current.map((item) => item.id === draft.id
            ? { ...item, status: "error", error: describeImageOptimizationError(optimizationError) }
            : item));
        }
      }
    }
  };

  const removeImage = (id: string) => {
    cancelledIds.current.add(id);
    setImages((current) => {
      const target = current.find((item) => item.id === id);
      if (target?.previewUrl) {
        URL.revokeObjectURL(target.previewUrl);
        previewUrls.current.delete(target.previewUrl);
      }
      return current.filter((item) => item.id !== id);
    });
  };

  const bindAll = async (job: PendingMediaBindJob) => {
    if (!csrfToken) throw new ApiRequestError(403, { error: { code: "INVALID_CSRF_TOKEN" } });
    const results = await Promise.allSettled(job.uploadIds.map((uploadId) => (
      bindUpload(uploadId, job.topicId, job.postId, csrfToken)
    )));
    if (results.some((result) => result.status === "rejected")) {
      const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
      throw rejected?.reason;
    }
  };

  const retryBinding = async () => {
    if (!pendingBind || busy) return;
    setBusy(true);
    setError("");
    setStage("bind");
    try {
      await bindAll(pendingBind);
      clearStoredBindJob(userId);
      setPendingBind(null);
      onCompleted();
    } catch (bindError) {
      persistBindJob(userId, pendingBind);
      setStage("bind_failed");
      setError(`${RESTORED_BIND_MESSAGE} ${uploadErrorMessage(bindError)}`);
    } finally {
      setBusy(false);
    }
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError("");
    setWarning("");
    if (!csrfToken) {
      setError("会话安全令牌不可用，请重新登录后再发布。");
      return;
    }
    if (pendingBind) {
      setStage("bind_failed");
      setError(RESTORED_BIND_MESSAGE);
      return;
    }
    if (!category) {
      setError("当前没有可发布的板块。");
      return;
    }
    if (optimizing || invalidImages) {
      setError("请等待图片优化完成，并移除处理失败的图片。 ");
      return;
    }
    const readyImages = images.flatMap((item) => item.image ? [item.image] : []);
    const altByIndex = images.flatMap((item) => item.image ? [safeMarkdownAlt(item.alt)] : []);
    let uploadIds: string[] = [];
    let topicCreated = false;
    let topicRequestStarted = false;
    setBusy(true);
    try {
      let markdownBody = body;
      if (readyImages.length > 0) {
        setStage("authorize");
        const authorization = await authorizeUploads(readyImages, csrfToken);
        uploadIds = recognizableAuthorizedUploadIds(authorization);
        if (
          authorization.uploads.length !== readyImages.length ||
          uploadIds.length !== authorization.uploads.length ||
          new Set(uploadIds).size !== uploadIds.length
        ) {
          throw new Error("UPLOAD_RESPONSE_MISMATCH");
        }
        if (authorization.capacityWarning) {
          setWarning(`站点媒体空间接近上限；本次许可后你的今日剩余额度约 ${formatBytes(authorization.quota.dailyRemainingBytes)}。`);
        }
        const objects = authorization.uploads.flatMap((remote, index) => {
          const local = readyImages[index];
          if (!local || !remote.thumbnail) throw new Error("UPLOAD_RESPONSE_MISMATCH");
          return [
            { request: remote.main, blob: local.main.blob },
            { request: remote.thumbnail, blob: local.thumbnail.blob },
          ];
        });
        setStage("upload");
        await putSignedObjects(objects, (settled, total) => {
          setUploadProgress(`正在直传 R2 · ${settled}/${total}`);
        });
        setStage("finalize");
        await finalizeUploads(authorization.reservationId, csrfToken);
        const mediaMarkdown = uploadIds.map((uploadId, index) => (
          `![${altByIndex[index] ?? "主题图片"}](/api/media/${uploadId})`
        )).join("\n\n");
        markdownBody = `${body.trimEnd()}\n\n${mediaMarkdown}`.trim();
        if (markdownBody.length > 50_000) throw new Error("BODY_TOO_LONG_WITH_MEDIA");
      }

      setStage("topic");
      topicRequestStarted = true;
      const response = await createTopic({
        categoryId: category.id,
        title: title.trim(),
        body: markdownBody,
        minViewLevel,
      }, csrfToken);
      topicCreated = true;
      onTopicCreated(response);
      if (uploadIds.length === 0) {
        onCompleted();
        return;
      }
      const bindJob = {
        topicId: response.topic.id,
        postId: response.topic.firstPostId,
        uploadIds,
      };
      const persisted = persistBindJob(userId, bindJob);
      setPendingBind(bindJob);
      if (!persisted) {
        setWarning("浏览器无法持久保存图片绑定状态；在绑定完成前请勿关闭或刷新页面。");
      }
      setStage("bind");
      try {
        await bindAll(bindJob);
        clearStoredBindJob(userId);
        setPendingBind(null);
        onCompleted();
      } catch (bindError) {
        persistBindJob(userId, bindJob);
        setStage("bind_failed");
        setError(`${RESTORED_BIND_MESSAGE} ${uploadErrorMessage(bindError)}`);
      }
    } catch (requestError) {
      if (uploadIds.length > 0 && !topicCreated) {
        await cleanupTemporaryUploads(uploadIds, csrfToken);
      }
      setStage("idle");
      setError(requestError instanceof Error && requestError.message === "BODY_TOO_LONG_WITH_MEDIA"
        ? "正文加入图片 Markdown 后超过 50000 字符，请删减正文或图片。"
        : topicRequestStarted ? topicErrorMessage(requestError) : uploadErrorMessage(requestError));
      if (requestError instanceof ApiRequestError && requestError.status === 401) onAuthenticationRequired();
    } finally {
      setBusy(false);
    }
  };

  const trustLevelOptions = ([0, 1, 2, 3, 4] as const).filter((value) => value <= levelMax);

  return (
    <div className="modal-backdrop" onMouseDown={(event) => !busy && event.target === event.currentTarget && onClose()}>
      <section aria-labelledby="compose-title" aria-modal="true" className="modal-card compose-modal compose-media-modal" role="dialog">
        <button aria-label="关闭编辑器" className="modal-close" disabled={busy} onClick={onClose} type="button">×</button>
        <p className="eyebrow">新讨论</p>
        <h2 id="compose-title">把问题讲清楚，就是好的开始</h2>
        <form onSubmit={(event) => void submit(event)}>
          <div className="compose-row">
            <label><span>板块</span><select disabled={busy || Boolean(pendingBind)} value={categoryId} onChange={(event) => changeCategory(event.target.value)} required>
              {availableCategories.length === 0 && <option value="">暂无可发布板块</option>}
              {availableCategories.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select></label>
            <label><span>谁可以看</span><select disabled={busy || Boolean(pendingBind)} value={minViewLevel} onChange={(event) => setMinViewLevel(Number(event.target.value) as TrustLevel)}>
              {trustLevelOptions.map((level) => <option key={level} value={level}>{level === 0 ? "所有人 · 公开" : `Lv${level} 及以上`}</option>)}
            </select></label>
          </div>
          <label><span>标题</span><input autoFocus disabled={busy || Boolean(pendingBind)} maxLength={120} minLength={3} onChange={(event) => setTitle(event.target.value)} required value={title} /></label>
          <label><span>正文 <small>支持 Markdown</small></span><textarea disabled={busy || Boolean(pendingBind)} maxLength={50000} onChange={(event) => setBody(event.target.value)} required rows={7} value={body} /></label>

          <section className="compose-images" aria-labelledby="compose-images-title">
            <div><strong id="compose-images-title">主题图片</strong><small>{images.length}/10</small></div>
            {category?.allowImages ? (
              <label className={busy || images.length >= 10 ? "image-picker is-disabled" : "image-picker"}>
                <input accept="image/jpeg,image/png,image/webp" disabled={busy || Boolean(pendingBind) || images.length >= 10} multiple onChange={(event) => void selectImages(event)} type="file" />
                <span>＋ 选择图片</span><small>JPEG / PNG / WebP，原图每张不超过 12 MB；选择后立即在本地剥离元数据并压缩。</small>
              </label>
            ) : <p className="images-disabled">此板块已由管理员关闭图片发布。</p>}
            {images.length > 0 && <div className="image-draft-list">{images.map((item) => (
              <article className={`image-draft is-${item.status}`} key={item.id}>
                {item.previewUrl ? <img alt="" src={item.previewUrl} /> : <span className="image-placeholder" aria-hidden="true">{item.status === "optimizing" ? "…" : "!"}</span>}
                <div><strong>{item.name}</strong>{item.image && <small>{item.image.main.width}×{item.image.main.height} · {formatBytes(item.image.main.bytes)} + 缩略图 {formatBytes(item.image.thumbnail.bytes)}</small>}
                  {item.status === "optimizing" && <small>正在本地解码、修正方向并压缩…</small>}{item.error && <small className="image-error">{item.error}</small>}
                  {item.status === "ready" && <label><span>图片说明</span><input disabled={busy} maxLength={80} onChange={(event) => setImages((current) => current.map((draft) => draft.id === item.id ? { ...draft, alt: event.target.value } : draft))} value={item.alt} /></label>}
                </div>
                <button aria-label={`移除 ${item.name}`} disabled={busy} onClick={() => removeImage(item.id)} type="button">移除</button>
              </article>
            ))}</div>}
          </section>

          {stage !== "idle" && <div className={stage === "bind_failed" ? "upload-progress is-warning" : "upload-progress"} role="status"><strong>{stageLabel(stage, uploadProgress)}</strong><small>本地优化 → 许可 → R2 直传 → 核验 → 发帖 → 绑定</small></div>}
          {warning && <div className="compose-warning" role="status">{warning}</div>}
          {error && <div className="compose-error" role="alert"><span aria-hidden="true">!</span>{error}</div>}
          <div className="compose-help"><span>图片仅通过预签名请求直传 R2</span><span>校验使用浏览器原生 SHA-256</span></div>
          <div className="modal-actions">
            <button className="button button-quiet" disabled={busy} onClick={onClose} type="button">{pendingBind ? "稍后处理" : "稍后再写"}</button>
            {pendingBind ? <button className="button button-primary" disabled={busy} onClick={() => void retryBinding()} type="button">{busy ? "正在重新绑定…" : "重试图片绑定"}</button>
              : <button className="button button-primary" disabled={busy || optimizing || invalidImages || availableCategories.length === 0} type="submit">{busy ? stageLabel(stage, uploadProgress) : "发布主题"}</button>}
          </div>
        </form>
      </section>
    </div>
  );
}
