import { useEffect, useRef, useState } from "react";
import { ApiRequestError, isSiteMaintenanceError } from "./api";
import {
  getNotifications,
  markNotificationsRead,
  type ForumNotification,
} from "./notifications";

type PanelStatus = "loading" | "ready" | "error";

interface NotificationPanelProps {
  csrfToken: string | null;
  onAuthenticationRequired: () => void;
  onClose: () => void;
  onNavigateTopic: (topicId: string, postId?: string | null) => void;
  onUnreadCountChange: (count: number) => void;
}

const ACTION_LABELS: Record<string, string> = {
  approve_registration: "注册申请已通过",
  reject_registration: "注册申请未通过",
  approve_first_post: "首篇内容已通过审核",
  reject_first_post: "首篇内容未通过审核",
  approve_media_post: "媒体内容已通过审核",
  reject_media_post: "媒体内容未通过审核",
  accept_report: "举报已核实并处理",
  dismiss_report: "举报审核后未予采纳",
};

function notificationTitle(notification: ForumNotification): string {
  const action = typeof notification.data.action === "string"
    ? ACTION_LABELS[notification.data.action]
    : undefined;
  if (action) return action;
  if (notification.kind === "review_decision") return "你的审核事项已有决定";
  if (notification.kind === "report_decision") return "你提交的举报已有处理结果";
  if (notification.kind === "content_moderated") return "你发布的内容已由版务处理";
  if (notification.kind === "trust_level_promoted") return "你的社区信任等级已提升";
  if (notification.kind === "trust_level_demoted") return "你的社区信任等级已调整";
  if (notification.kind === "trust_level_demotion_warning") return "信任等级即将调整";
  return "你有一条新的社区通知";
}

function notificationDetail(notification: ForumNotification): string | null {
  if (
    (notification.kind === "trust_level_promoted" ||
      notification.kind === "trust_level_demoted" ||
      notification.kind === "trust_level_demotion_warning") &&
    typeof notification.data.fromLevel === "number" &&
    typeof notification.data.toLevel === "number"
  ) {
    const levelChange = `Lv${notification.data.fromLevel} → Lv${notification.data.toLevel}`;
    if (
      notification.kind === "trust_level_demotion_warning" &&
      typeof notification.data.deadlineAt === "number"
    ) {
      const timestamp = notification.data.deadlineAt < 1_000_000_000_000
        ? notification.data.deadlineAt * 1_000
        : notification.data.deadlineAt;
      const deadline = new Date(timestamp);
      if (!Number.isNaN(deadline.getTime())) {
        return `${levelChange} · 请在 ${deadline.toLocaleString("zh-CN")} 前恢复活跃度`;
      }
    }
    return levelChange;
  }
  if (typeof notification.data.reason === "string" && notification.data.reason) {
    return notification.data.reason;
  }
  return notification.actor ? `由 ${notification.actor.displayName} 处理` : null;
}

function formatNotificationTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "时间未知";
  const elapsed = Math.max(1, Math.floor((Date.now() - date.getTime()) / 60_000));
  if (elapsed < 60) return `${elapsed} 分钟前`;
  const hours = Math.floor(elapsed / 60);
  if (hours < 24) return `${hours} 小时前`;
  return new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric" }).format(date);
}

function targetHref(notification: ForumNotification): string | null {
  if (!notification.targetAvailable || !notification.topicId) return null;
  return `/t/${encodeURIComponent(notification.topicId)}${
    notification.postId ? `#post-${encodeURIComponent(notification.postId)}` : ""
  }`;
}

export default function NotificationPanel({
  csrfToken,
  onAuthenticationRequired,
  onClose,
  onNavigateTopic,
  onUnreadCountChange,
}: NotificationPanelProps) {
  const [status, setStatus] = useState<PanelStatus>("loading");
  const [notifications, setNotifications] = useState<ForumNotification[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [unreadCount, setUnreadCount] = useState(0);
  const [error, setError] = useState("");
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [markingAll, setMarkingAll] = useState(false);
  const [markingIds, setMarkingIds] = useState<Set<string>>(() => new Set());
  const loadMoreControllerRef = useRef<AbortController | null>(null);
  const authRequiredRef = useRef(onAuthenticationRequired);
  const unreadChangeRef = useRef(onUnreadCountChange);

  useEffect(() => {
    authRequiredRef.current = onAuthenticationRequired;
    unreadChangeRef.current = onUnreadCountChange;
  }, [onAuthenticationRequired, onUnreadCountChange]);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  useEffect(() => {
    const controller = new AbortController();
    loadMoreControllerRef.current?.abort();
    setStatus("loading");
    setError("");
    setNotifications([]);
    setNextCursor(null);
    void getNotifications(undefined, controller.signal)
      .then((response) => {
        setNotifications(response.notifications);
        setNextCursor(response.nextCursor);
        setUnreadCount(response.unreadCount);
        unreadChangeRef.current(response.unreadCount);
        setStatus("ready");
      })
      .catch((requestError: unknown) => {
        if (requestError instanceof DOMException && requestError.name === "AbortError") return;
        if (requestError instanceof ApiRequestError && requestError.status === 401) {
          authRequiredRef.current();
          return;
        }
        setError(
          requestError instanceof ApiRequestError && requestError.status === 403
            ? "当前账号状态不能读取通知。"
            : "通知暂时没有送达，请检查网络后重试。",
        );
        setStatus("error");
      });
    return () => controller.abort();
  }, [refreshVersion]);

  useEffect(() => () => loadMoreControllerRef.current?.abort(), []);

  const loadMore = async () => {
    if (!nextCursor || loadingMore) return;
    const controller = new AbortController();
    loadMoreControllerRef.current?.abort();
    loadMoreControllerRef.current = controller;
    setLoadingMore(true);
    setError("");
    try {
      const response = await getNotifications(nextCursor, controller.signal);
      setNotifications((current) => {
        const seen = new Set(current.map((notification) => notification.id));
        return [
          ...current,
          ...response.notifications.filter((notification) => !seen.has(notification.id)),
        ];
      });
      setNextCursor(response.nextCursor);
      setUnreadCount(response.unreadCount);
      unreadChangeRef.current(response.unreadCount);
    } catch (requestError) {
      if (!(requestError instanceof DOMException && requestError.name === "AbortError")) {
        if (requestError instanceof ApiRequestError && requestError.status === 401) {
          authRequiredRef.current();
        } else {
          setError("更多通知载入失败，请稍后重试。");
        }
      }
    } finally {
      if (loadMoreControllerRef.current === controller) {
        loadMoreControllerRef.current = null;
        setLoadingMore(false);
      }
    }
  };

  const applyUnreadCount = (count: number) => {
    setUnreadCount(count);
    unreadChangeRef.current(count);
  };

  const markOneRead = async (notification: ForumNotification) => {
    if (notification.readAt || markingIds.has(notification.id)) return;
    if (!csrfToken) {
      setError("会话安全令牌不可用，请刷新页面后重试。");
      return;
    }
    setMarkingIds((current) => new Set(current).add(notification.id));
    setError("");
    try {
      const response = await markNotificationsRead({ ids: [notification.id] }, csrfToken);
      const readAt = new Date().toISOString();
      setNotifications((current) => current.map((item) => (
        item.id === notification.id ? { ...item, readAt } : item
      )));
      applyUnreadCount(response.unreadCount);
    } catch (requestError) {
      if (isSiteMaintenanceError(requestError)) {
        setError("站点正在维护；通知仍可阅读，但暂时不能更新已读状态。");
      } else if (requestError instanceof ApiRequestError && requestError.status === 401) {
        authRequiredRef.current();
      } else if (requestError instanceof ApiRequestError && requestError.code === "INVALID_CSRF_TOKEN") {
        setError("会话安全令牌已失效，请刷新页面后重试。");
      } else {
        setError("这条通知尚未标为已读，请稍后重试。");
      }
    } finally {
      setMarkingIds((current) => {
        const next = new Set(current);
        next.delete(notification.id);
        return next;
      });
    }
  };

  const markAllRead = async () => {
    if (markingAll || unreadCount === 0) return;
    if (!csrfToken) {
      setError("会话安全令牌不可用，请刷新页面后重试。");
      return;
    }
    setMarkingAll(true);
    setError("");
    try {
      const response = await markNotificationsRead({ all: true }, csrfToken);
      const readAt = new Date().toISOString();
      setNotifications((current) => current.map((notification) => (
        notification.readAt ? notification : { ...notification, readAt }
      )));
      applyUnreadCount(response.unreadCount);
    } catch (requestError) {
      if (isSiteMaintenanceError(requestError)) {
        setError("站点正在维护；通知仍可阅读，但暂时不能更新已读状态。");
      } else if (requestError instanceof ApiRequestError && requestError.status === 401) {
        authRequiredRef.current();
      } else if (requestError instanceof ApiRequestError && requestError.code === "INVALID_CSRF_TOKEN") {
        setError("会话安全令牌已失效，请刷新页面后重试。");
      } else {
        setError("通知尚未全部标为已读，请稍后重试。");
      }
    } finally {
      setMarkingAll(false);
    }
  };

  return (
    <div className="notification-layer" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section aria-labelledby="notifications-title" className="notification-panel" id="notification-panel" role="dialog">
        <header>
          <div>
            <p className="eyebrow">你的社区动态</p>
            <h2 id="notifications-title">通知</h2>
          </div>
          <div className="notification-header-actions">
            <button disabled={markingAll || unreadCount === 0} onClick={() => void markAllRead()} type="button">
              {markingAll ? "处理中…" : "全部已读"}
            </button>
            <button aria-label="关闭通知" autoFocus className="notification-close" onClick={onClose} type="button">×</button>
          </div>
        </header>

        {error && <div className="notification-error" role="alert">{error}</div>}
        {status === "loading" && <NotificationLoading />}
        {status === "error" && (
          <div className="notification-state">
            <span aria-hidden="true">!</span>
            <p>通知暂时无法载入</p>
            <button onClick={() => setRefreshVersion((value) => value + 1)} type="button">重新载入</button>
          </div>
        )}
        {status === "ready" && notifications.length === 0 && (
          <div className="notification-state">
            <span aria-hidden="true">○</span>
            <p>还没有新通知</p>
            <small>参与讨论后，回复和版务结果会出现在这里。</small>
          </div>
        )}
        {status === "ready" && notifications.length > 0 && (
          <div className="notification-list">
            {notifications.map((notification) => {
              const href = targetHref(notification);
              const marking = markingIds.has(notification.id);
              return (
                <article className={notification.readAt ? "notification-item" : "notification-item is-unread"} key={notification.id}>
                  <span className="notification-avatar" aria-hidden="true">
                    {notification.actor ? [...notification.actor.displayName][0] ?? "版" : "讯"}
                  </span>
                  <div className="notification-copy">
                    {href ? (
                      <a
                        href={href}
                        onClick={(event) => {
                          if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                          event.preventDefault();
                          onNavigateTopic(notification.topicId as string, notification.postId);
                        }}
                      >{notificationTitle(notification)}</a>
                    ) : (
                      <strong>{notificationTitle(notification)}</strong>
                    )}
                    {notificationDetail(notification) && <p>{notificationDetail(notification)}</p>}
                    {!notification.targetAvailable && (
                      <p className="notification-unavailable">相关内容已不可用</p>
                    )}
                    <time dateTime={notification.createdAt}>{formatNotificationTime(notification.createdAt)}</time>
                  </div>
                  {!notification.readAt && (
                    <button
                      aria-label="标为已读"
                      className="mark-read"
                      disabled={marking}
                      onClick={() => void markOneRead(notification)}
                      type="button"
                    >{marking ? "…" : "读"}</button>
                  )}
                </article>
              );
            })}
            {nextCursor && (
              <button className="notification-more" disabled={loadingMore} onClick={() => void loadMore()} type="button">
                {loadingMore ? "正在载入…" : "查看更早通知"}
              </button>
            )}
          </div>
        )}
      </section>
    </div>
  );
}

function NotificationLoading() {
  return (
    <div aria-busy="true" aria-live="polite" className="notification-loading">
      <p className="visually-hidden">正在载入通知</p>
      {[0, 1, 2].map((item) => (
        <div key={item}>
          <span />
          <section><i /><i /></section>
        </div>
      ))}
    </div>
  );
}
