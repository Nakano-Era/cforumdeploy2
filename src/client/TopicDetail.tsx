import { useEffect, useRef, useState, type FormEvent } from "react";
import ReactMarkdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { ApiRequestError, isSiteMaintenanceError } from "./api";
import type { AuthUser } from "./auth";
import {
  createReply,
  getTopicDetail,
  setLikeReaction,
  setTopicPinned,
  type TopicDetailPost,
  type TopicDetailResponse,
} from "./topic";

type DetailStatus = "loading" | "ready" | "error" | "not_found";

interface TopicDetailProps {
  topicId: string;
  hash: string;
  authUser: AuthUser | null;
  csrfToken: string | null;
  maintenanceMode: boolean;
  onAuthenticationRequired: (message: string) => void;
  onBack: () => void;
  onLogin: () => void;
  onOpenCategory: (categorySlug: string) => void;
  onPinChanged: () => void;
  onReplyCreated: (postId: string) => void;
}

function formatPostTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "时间未知";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function replyRestriction(
  detail: TopicDetailResponse,
  authUser: AuthUser | null,
  lockedAfterError: boolean,
  maintenanceReadOnly: boolean,
): string | null {
  if (maintenanceReadOnly) return "站点正在维护，暂时只开放阅读。";
  if (!authUser) return "登录后即可参与这场讨论。";
  if (authUser.status === "silenced") return "当前账号处于禁言状态，暂时不能回复。";
  if (lockedAfterError || detail.topic.status === "locked" || detail.topic.status === "archived") {
    return "这篇主题已经锁定，只能继续阅读。";
  }
  if (detail.access.via === "author_read_only") {
    return "你的等级已低于这篇主题的可见要求；仍可阅读曾发布的内容，但不能继续回复。";
  }
  if (detail.access.readOnly) return "你通过只读权限查看这篇主题，当前不能回复。";
  if (detail.access.canReply) return null;
  if (detail.access.replyReason === "level_too_low") return "你的当前信任等级还不能回复这篇主题。";
  if (detail.access.replyReason === "account_inactive") return "当前账号状态不能回复。";
  if (detail.access.replyReason === "topic_read_only") return "这篇主题当前只允许阅读。";
  if (detail.access.replyReason === "category_moderator") return "版主代管查看为只读状态。";
  return "当前没有回复这篇主题的权限。";
}

function detailLoadError(error: unknown): DetailStatus {
  if (error instanceof ApiRequestError && error.status === 404) return "not_found";
  return "error";
}

export default function TopicDetail({
  topicId,
  hash,
  authUser,
  csrfToken,
  maintenanceMode,
  onAuthenticationRequired,
  onBack,
  onLogin,
  onOpenCategory,
  onPinChanged,
  onReplyCreated,
}: TopicDetailProps) {
  const [detail, setDetail] = useState<TopicDetailResponse | null>(null);
  const [status, setStatus] = useState<DetailStatus>("loading");
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [loadedVersion, setLoadedVersion] = useState(0);
  const [likeBusy, setLikeBusy] = useState<Set<string>>(() => new Set());
  const [pinBusy, setPinBusy] = useState(false);
  const [replyBody, setReplyBody] = useState("");
  const maintenanceReadOnly = maintenanceMode && authUser?.role !== "admin";
  const isActiveAdmin =
    authUser?.role === "admin" && authUser.status === "active";
  const [replyBusy, setReplyBusy] = useState(false);
  const [replyError, setReplyError] = useState("");
  const [replyOutcome, setReplyOutcome] = useState("");
  const [notice, setNotice] = useState("");
  const [lockedAfterError, setLockedAfterError] = useState(false);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const topicIdRef = useRef(topicId);
  topicIdRef.current = topicId;

  useEffect(() => {
    setReplyBody("");
    setReplyError("");
    setReplyOutcome("");
    setNotice("");
    setLikeBusy(new Set());
    setPinBusy(false);
  }, [topicId]);

  useEffect(() => {
    const controller = new AbortController();
    setStatus("loading");
    setDetail(null);
    setLockedAfterError(false);
    void getTopicDetail(topicId, controller.signal)
      .then((response) => {
        setDetail({
          ...response,
          posts: response.posts.map((post) => ({ ...post, liked: post.liked ?? false })),
        });
        setStatus("ready");
        setLoadedVersion((version) => version + 1);
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setStatus(detailLoadError(error));
      });
    return () => controller.abort();
  }, [authUser?.id, refreshVersion, topicId]);

  useEffect(() => {
    if (status !== "ready") return;
    const frame = window.requestAnimationFrame(() => {
      let target: HTMLElement | null = null;
      if (hash.startsWith("#")) {
        try {
          target = document.getElementById(decodeURIComponent(hash.slice(1)));
        } catch {
          target = null;
        }
      }
      if (target) {
        target.focus({ preventScroll: true });
        target.scrollIntoView({
          behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
          block: "center",
        });
      } else if (hash) {
        headingRef.current?.focus({ preventScroll: true });
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [hash, loadedVersion, status]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 4200);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const toggleLike = async (post: TopicDetailPost) => {
    if (maintenanceReadOnly) {
      setNotice("站点正在维护，暂时只开放阅读");
      return;
    }
    if (likeBusy.has(post.id)) return;
    if (!authUser) {
      onLogin();
      return;
    }
    if (authUser.status === "silenced") {
      setNotice("当前账号状态不能点赞");
      return;
    }
    if (!csrfToken) {
      setNotice("会话安全令牌不可用，请刷新页面后重试");
      return;
    }

    const previousActive = post.liked ?? false;
    const previousCount = post.likeCount;
    const desired = !previousActive;
    const updatePost = (active: boolean, likeCount: number, topicLikeCount?: number) => {
      setDetail((current) => {
        if (!current || current.topic.id !== topicId) return current;
        return {
          ...current,
          topic: topicLikeCount === undefined
            ? current.topic
            : { ...current.topic, likeCount: topicLikeCount },
          posts: current.posts.map((item) => (
            item.id === post.id ? { ...item, liked: active, likeCount } : item
          )),
        };
      });
    };

    setLikeBusy((current) => new Set(current).add(post.id));
    updatePost(desired, Math.max(0, previousCount + (desired ? 1 : -1)));
    try {
      const response = await setLikeReaction(post.id, desired, csrfToken);
      if (topicIdRef.current !== topicId) return;
      if (response.post.id !== post.id || response.topic.id !== topicId) {
        throw new Error("reaction_response_mismatch");
      }
      updatePost(response.reaction.active, response.post.likeCount, response.topic.likeCount);
      setNotice(response.reaction.active ? "已点赞" : "已取消点赞");
    } catch (error) {
      if (topicIdRef.current !== topicId) return;
      updatePost(previousActive, previousCount);
      if (isSiteMaintenanceError(error)) {
        setNotice("站点正在维护，暂时只开放阅读；点赞没有提交");
      } else if (error instanceof ApiRequestError && error.status === 401) {
        onAuthenticationRequired("登录状态已失效，请重新登录后点赞");
      } else if (error instanceof ApiRequestError && error.code === "INVALID_CSRF_TOKEN") {
        setNotice("会话安全令牌已失效，请刷新页面后重试");
      } else if (error instanceof ApiRequestError && error.status === 403) {
        setNotice("当前账号状态不能点赞");
      } else if (error instanceof ApiRequestError && error.status === 404) {
        setNotice("这篇帖子已不存在或不可访问");
      } else {
        setNotice("点赞没有成功，已恢复原状态");
      }
    } finally {
      setLikeBusy((current) => {
        const next = new Set(current);
        next.delete(post.id);
        return next;
      });
    }
  };

  const togglePinned = async () => {
    if (!detail || pinBusy || !isActiveAdmin) return;
    if (!csrfToken) {
      setNotice("会话安全令牌不可用，请刷新页面后重试");
      return;
    }

    const desired = !detail.topic.pinned;
    setPinBusy(true);
    try {
      const response = await setTopicPinned(topicId, desired, csrfToken);
      if (topicIdRef.current !== topicId) return;
      if (response.topic.id !== topicId) {
        throw new Error("topic_pin_response_mismatch");
      }
      setDetail((current) =>
        current && current.topic.id === topicId
          ? {
              ...current,
              topic: { ...current.topic, pinned: response.topic.pinned },
            }
          : current,
      );
      onPinChanged();
      setNotice(
        response.topic.pinned
          ? response.changed
            ? "主题已置顶，首页排序已更新"
            : "主题已经是置顶状态"
          : response.changed
            ? "已取消置顶，首页排序已更新"
            : "主题已经不是置顶状态",
      );
    } catch (error) {
      if (topicIdRef.current !== topicId) return;
      if (isSiteMaintenanceError(error)) {
        setNotice("站点正在维护，置顶状态没有更新");
      } else if (error instanceof ApiRequestError && error.status === 401) {
        onAuthenticationRequired("登录状态已失效，请重新登录后管理主题");
      } else if (
        error instanceof ApiRequestError &&
        error.code === "INVALID_CSRF_TOKEN"
      ) {
        setNotice("会话安全令牌已失效，请刷新页面后重试");
      } else if (error instanceof ApiRequestError && error.status === 403) {
        setNotice("只有状态正常的管理员可以置顶主题");
      } else if (error instanceof ApiRequestError && error.status === 404) {
        setNotice("这篇主题已不存在或当前状态不能置顶");
      } else {
        setNotice("置顶状态更新失败，请稍后再试");
      }
    } finally {
      setPinBusy(false);
    }
  };

  const submitReply = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!detail || replyBusy) return;
    if (!authUser) {
      onLogin();
      return;
    }
    const restriction = replyRestriction(detail, authUser, lockedAfterError, maintenanceReadOnly);
    if (restriction) {
      setReplyError(restriction);
      return;
    }
    if (!csrfToken) {
      setReplyError("会话安全令牌不可用，请刷新页面后重试。");
      return;
    }
    if (!replyBody.trim()) {
      setReplyError("请先写下回复内容。");
      return;
    }

    setReplyBusy(true);
    setReplyError("");
    setReplyOutcome("");
    try {
      const response = await createReply(topicId, replyBody, csrfToken);
      if (topicIdRef.current !== topicId) return;
      setReplyBody("");
      if (response.post.reviewRequired || response.post.status === "pending") {
        setReplyOutcome("回复已进入审核队列；通过后会自动出现在这场讨论中。你无需重复提交。");
        setNotice("回复已提交审核；通过后会出现在讨论中");
      } else {
        onReplyCreated(response.post.id);
        setNotice("回复发布成功，正在刷新讨论");
        setRefreshVersion((version) => version + 1);
      }
    } catch (error) {
      if (topicIdRef.current !== topicId) return;
      if (isSiteMaintenanceError(error)) {
        setReplyError("站点正在维护，暂时只开放阅读；你的回复仍保留在编辑框中。");
      } else if (error instanceof ApiRequestError && error.status === 401) {
        onAuthenticationRequired("登录状态已失效，请重新登录后回复");
      } else if (error instanceof ApiRequestError && error.code === "INVALID_CSRF_TOKEN") {
        setReplyError("会话安全令牌已失效，请刷新页面后重试。");
      } else if (error instanceof ApiRequestError && error.status === 404) {
        setReplyError("这篇主题已不存在或你不再有权查看。");
      } else if (error instanceof ApiRequestError && error.status === 409) {
        setLockedAfterError(true);
        setReplyError("主题刚刚已被锁定，回复没有提交。");
      } else if (error instanceof ApiRequestError && error.status === 403) {
        setReplyError("你的账号、等级或板块权限不允许回复这篇主题。");
      } else if (error instanceof ApiRequestError && error.status === 422) {
        setReplyError("回复内容为空或过长，请检查后重试。");
      } else {
        setReplyError("回复没有提交成功，请检查网络后重试。");
      }
    } finally {
      setReplyBusy(false);
    }
  };

  if (status === "loading") return <TopicLoading onBack={onBack} />;
  if (status === "not_found") {
    return (
      <main className="topic-page" id="main-content">
        <button className="topic-back" onClick={onBack} type="button">← 返回信息流</button>
        <section className="topic-page-state" role="alert">
          <span aria-hidden="true">○</span>
          <h1>这篇主题无法打开</h1>
          <p>它可能已被删除、移动到你无权查看的板块，或链接已经失效。</p>
          <button className="button button-secondary" onClick={onBack} type="button">回到社区</button>
        </section>
      </main>
    );
  }
  if (status === "error" || !detail) {
    return (
      <main className="topic-page" id="main-content">
        <button className="topic-back" onClick={onBack} type="button">← 返回信息流</button>
        <section className="topic-page-state" role="alert">
          <span aria-hidden="true">!</span>
          <h1>讨论暂时没有送达</h1>
          <p>请检查网络或 Worker 状态后重试。</p>
          <button className="button button-secondary" onClick={() => setRefreshVersion((version) => version + 1)} type="button">重新载入</button>
        </section>
      </main>
    );
  }

  const restriction = replyRestriction(detail, authUser, lockedAfterError, maintenanceReadOnly);
  const canReply = !restriction && detail.access.canReply;

  return (
    <main className="topic-page" id="main-content">
      <button className="topic-back" onClick={onBack} type="button">← 返回信息流</button>
      <header className="topic-detail-header">
        <div className="topic-detail-kicker">
          <button onClick={() => onOpenCategory(detail.topic.category.slug)} type="button">
            <span style={{ background: detail.topic.category.accent }} />
            {detail.topic.category.name}
          </button>
          {detail.topic.status !== "open" && <span className="status-chip lock-chip">{detail.topic.status === "locked" ? "已锁定" : "只读"}</span>}
          {detail.topic.pinned && <span className="status-chip pinned-chip">置顶</span>}
          {detail.topic.effectiveMinViewLevel > 0 && <span className="status-chip level-chip">Lv{detail.topic.effectiveMinViewLevel}+ 可见</span>}
        </div>
        <h1 ref={headingRef} tabIndex={-1}>{detail.topic.title}</h1>
        <div className="topic-detail-meta">
          <span>{detail.posts.length} 篇帖子</span>
          <span>{detail.topic.replyCount} 条回复</span>
          <span>{detail.topic.likeCount} 个赞</span>
          <time dateTime={detail.topic.createdAt}>创建于 {formatPostTime(detail.topic.createdAt)}</time>
        </div>
        {detail.tags.length > 0 && (
          <div aria-label="主题标签" className="topic-detail-tags">
            {detail.tags.map((tag) => <span key={tag.slug}>#{tag.name}</span>)}
          </div>
        )}
        {isActiveAdmin && (
          <div className="topic-detail-admin-actions">
            <button
              aria-busy={pinBusy}
              className="button button-secondary"
              disabled={pinBusy}
              onClick={() => void togglePinned()}
              type="button"
            >
              {pinBusy
                ? "正在更新…"
                : detail.topic.pinned
                  ? "取消置顶"
                  : "置顶主题"}
            </button>
          </div>
        )}
      </header>

      <section aria-label="主题帖子" className="post-stream">
        {detail.posts.map((post) => (
          <article className={post.number === 1 ? "post-card is-first-post" : "post-card"} id={`post-${post.id}`} key={post.id} tabIndex={-1}>
            <aside className="post-author">
              <div>
                <span aria-hidden="true">{post.author.avatarUrl ? <img alt="" src={post.author.avatarUrl} /> : ([...post.author.displayName][0] ?? "友")}</span>
                <strong>{post.author.displayName}</strong>
                <small>@{post.author.username}</small>
              </div>
              <b>Lv{post.author.trustLevel}</b>
            </aside>
            <div className="post-content">
              <header>
                <span>{post.number === 1 ? "主题首帖" : `#${post.number}`}</span>
                <time dateTime={post.createdAt}>{formatPostTime(post.createdAt)}</time>
                {post.updatedAt !== post.createdAt && <small>已编辑</small>}
              </header>
              <div className="markdown-body">
                <ReactMarkdown rehypePlugins={[rehypeSanitize]} remarkPlugins={[remarkGfm]}>
                  {post.markdown}
                </ReactMarkdown>
              </div>
              <footer>
                <a className="post-permalink" href={`#post-${post.id}`} aria-label={`帖子 ${post.number} 的固定链接`}>#{post.number}</a>
                <button
                  aria-busy={likeBusy.has(post.id)}
                  aria-label={post.liked ? "取消点赞" : "点赞这篇帖子"}
                  aria-pressed={post.liked ?? false}
                  className={post.liked ? "post-like is-liked" : "post-like"}
                  disabled={maintenanceReadOnly || likeBusy.has(post.id)}
                  onClick={() => void toggleLike(post)}
                  type="button"
                >
                  <span aria-hidden="true">{likeBusy.has(post.id) ? "…" : post.liked ? "♥" : "♡"}</span>
                  {post.likeCount > 0 ? post.likeCount : "赞"}
                </button>
              </footer>
            </div>
          </article>
        ))}
      </section>

      <section aria-labelledby="reply-heading" className="reply-composer">
        <div className="reply-heading">
          <div>
            <p className="eyebrow">继续这场讨论</p>
            <h2 id="reply-heading">写下你的回复</h2>
          </div>
          {authUser && <span>以 {authUser.displayName} · Lv{authUser.trustLevel} 回复</span>}
        </div>
        {restriction && (
          <div className="reply-restriction" role="status">
            <span aria-hidden="true">锁</span>
            <div><strong>当前为只读</strong><p>{restriction}</p></div>
            {!authUser && <button className="button button-primary" onClick={onLogin} type="button">登录后回复</button>}
          </div>
        )}
        <form onSubmit={(event) => void submitReply(event)}>
          <label>
            <span className="visually-hidden">回复正文，支持 Markdown</span>
            <textarea
              disabled={!canReply || replyBusy}
              maxLength={50_000}
              onChange={(event) => { setReplyBody(event.target.value); setReplyError(""); setReplyOutcome(""); }}
              placeholder={canReply ? "认真回应，也给不同意见留出空间。支持 Markdown。" : "这篇主题当前不能回复"}
              rows={8}
              value={replyBody}
            />
          </label>
          <div className="reply-form-footer">
            <span>支持 Markdown · {replyBody.length}/50000</span>
            <button aria-busy={replyBusy} className="button button-primary" disabled={!canReply || replyBusy || !replyBody.trim()} type="submit">
              {replyBusy ? "正在提交…" : "发布回复"}
            </button>
          </div>
          {replyError && <div className="compose-error" role="alert"><span aria-hidden="true">!</span>{replyError}</div>}
          {replyOutcome && <div className="reply-outcome" role="status"><span aria-hidden="true">✓</span>{replyOutcome}</div>}
        </form>
      </section>

      <div aria-atomic="true" aria-live="polite" className="topic-notice-region">
        {notice && <div className="toast">{notice}</div>}
      </div>
    </main>
  );
}

function TopicLoading({ onBack }: { onBack: () => void }) {
  return (
    <main aria-busy="true" className="topic-page" id="main-content">
      <button className="topic-back" onClick={onBack} type="button">← 返回信息流</button>
      <p className="visually-hidden">正在载入主题</p>
      <div className="topic-detail-skeleton">
        <div className="skeleton-line skeleton-short" />
        <div className="skeleton-line skeleton-title" />
        <div className="skeleton-line skeleton-medium" />
      </div>
      {[0, 1, 2].map((item) => (
        <div className="post-skeleton" key={item}>
          <span />
          <div><i /><i /><i /></div>
        </div>
      ))}
    </main>
  );
}
