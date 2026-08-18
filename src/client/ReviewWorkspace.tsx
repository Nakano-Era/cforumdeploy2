import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { ApiRequestError, isSiteMaintenanceError } from "./api";
import type { CategorySummary } from "./feed";
import {
  decideReviewItem,
  getReviewQueue,
  type ReviewItem,
  type ReviewQueueResponse,
} from "./moderation";

const REVIEW_TYPES = [
  { value: "registration", label: "注册申请" },
  { value: "first_post", label: "新成员首帖" },
  { value: "media_post", label: "媒体内容" },
  { value: "report", label: "用户举报" },
] as const;

type ReviewType = (typeof REVIEW_TYPES)[number]["value"];
type WorkspaceStatus = "loading" | "ready" | "error";
type FailureKind = "authentication" | "permission" | "network";
type Decision = "approve" | "reject";

interface ReviewWorkspaceProps {
  categories: CategorySummary[];
  csrfToken: string | null;
  onAuthenticationRequired: () => void;
  onExit: () => void;
  onNotice: (message: string) => void;
}

interface Confirmation {
  item: ReviewItem;
  decision: Decision;
}

function reviewTypeLabel(type: string): string {
  return REVIEW_TYPES.find((option) => option.value === type)?.label ?? type;
}

function formatReviewTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "时间未知";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function readReportSnapshot(snapshot: unknown): {
  reportType: string | null;
  detail: string | null;
} {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    return { reportType: null, detail: null };
  }
  const record = snapshot as Record<string, unknown>;
  return {
    reportType: typeof record.reportType === "string" ? record.reportType : null,
    detail: typeof record.detail === "string" ? record.detail : null,
  };
}

const REPORT_TYPE_LABELS: Record<string, string> = {
  off_topic: "偏离主题",
  inappropriate: "不当内容",
  spam: "垃圾信息",
  illegal: "涉嫌违法",
  other: "其他问题",
};

function queueFailure(error: unknown): FailureKind {
  if (error instanceof ApiRequestError && error.status === 401) return "authentication";
  if (error instanceof ApiRequestError && error.status === 403) return "permission";
  return "network";
}

export default function ReviewWorkspace({
  categories,
  csrfToken,
  onAuthenticationRequired,
  onExit,
  onNotice,
}: ReviewWorkspaceProps) {
  const [typeFilter, setTypeFilter] = useState<"all" | ReviewType>("all");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [status, setStatus] = useState<WorkspaceStatus>("loading");
  const [failure, setFailure] = useState<FailureKind | null>(null);
  const [items, setItems] = useState<ReviewItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [capabilities, setCapabilities] = useState<ReviewQueueResponse["capabilities"] | null>(null);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [note, setNote] = useState("");
  const [decisionBusy, setDecisionBusy] = useState(false);
  const [decisionError, setDecisionError] = useState("");
  const loadMoreControllerRef = useRef<AbortController | null>(null);
  const authRequiredRef = useRef(onAuthenticationRequired);

  useEffect(() => {
    authRequiredRef.current = onAuthenticationRequired;
  }, [onAuthenticationRequired]);

  useEffect(() => {
    const controller = new AbortController();
    loadMoreControllerRef.current?.abort();
    setLoadingMore(false);
    setStatus("loading");
    setFailure(null);
    setItems([]);
    setNextCursor(null);

    void getReviewQueue(
      {
        status: "pending",
        ...(typeFilter !== "all" ? { type: typeFilter } : {}),
        ...(categoryFilter !== "all" ? { category: categoryFilter } : {}),
      },
      controller.signal,
    )
      .then((response) => {
        setItems(response.items);
        setNextCursor(response.nextCursor);
        setCapabilities(response.capabilities);
        setStatus("ready");
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        const kind = queueFailure(error);
        setFailure(kind);
        setStatus("error");
        if (kind === "authentication") authRequiredRef.current();
      });

    return () => controller.abort();
  }, [categoryFilter, refreshVersion, typeFilter]);

  useEffect(() => () => loadMoreControllerRef.current?.abort(), []);

  useEffect(() => {
    if (!confirmation) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !decisionBusy) setConfirmation(null);
    };
    document.body.classList.add("modal-open");
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.body.classList.remove("modal-open");
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [confirmation, decisionBusy]);

  const availableCategories = useMemo(() => {
    const categoryNames = new Map(categories.map((category) => [category.id, category.name]));
    items.forEach((item) => {
      if (item.category) categoryNames.set(item.category.id, item.category.name);
    });
    if (!capabilities || capabilities.scope === "global") {
      return [...categoryNames].map(([id, name]) => ({ id, name }));
    }
    return capabilities.categoryIds.map((id) => ({
      id,
      name: categoryNames.get(id) ?? `板块 ${id}`,
    }));
  }, [capabilities, categories, items]);

  const loadMore = async () => {
    if (!nextCursor || loadingMore) return;
    loadMoreControllerRef.current?.abort();
    const controller = new AbortController();
    loadMoreControllerRef.current = controller;
    setLoadingMore(true);
    try {
      const response = await getReviewQueue(
        {
          status: "pending",
          cursor: nextCursor,
          ...(typeFilter !== "all" ? { type: typeFilter } : {}),
          ...(categoryFilter !== "all" ? { category: categoryFilter } : {}),
        },
        controller.signal,
      );
      setItems((current) => {
        const seen = new Set(current.map((item) => item.id));
        return [...current, ...response.items.filter((item) => !seen.has(item.id))];
      });
      setNextCursor(response.nextCursor);
      setCapabilities(response.capabilities);
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        const kind = queueFailure(error);
        if (kind === "authentication") {
          authRequiredRef.current();
        } else if (kind === "permission") {
          setFailure("permission");
          setStatus("error");
          onNotice("当前账号无法继续读取审核队列");
        } else {
          onNotice("更多审核事项载入失败，请稍后重试");
        }
      }
    } finally {
      if (loadMoreControllerRef.current === controller) {
        loadMoreControllerRef.current = null;
        setLoadingMore(false);
      }
    }
  };

  const openConfirmation = (item: ReviewItem, decision: Decision) => {
    setConfirmation({ item, decision });
    setNote("");
    setDecisionError("");
  };

  const submitDecision = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!confirmation || decisionBusy) return;
    if (!csrfToken) {
      setDecisionError("会话安全令牌不可用，请刷新页面后再处理。");
      return;
    }

    setDecisionBusy(true);
    setDecisionError("");
    try {
      const response = await decideReviewItem(
        confirmation.item.id,
        {
          decision: confirmation.decision,
          ...(note.trim() ? { note: note.trim() } : {}),
        },
        csrfToken,
      );
      if (response.item.id !== confirmation.item.id) {
        throw new Error("review_response_mismatch");
      }
      setItems((current) => current.filter((item) => item.id !== response.item.id));
      setConfirmation(null);
      setNote("");
      onNotice(
        response.item.status === "approved"
          ? "审核事项已批准，队列已更新"
          : "审核事项已驳回，队列已更新",
      );
    } catch (error) {
      if (isSiteMaintenanceError(error)) {
        setDecisionError("站点正在维护；审核队列仍可查看，但暂时不能提交决定。管理员可在管理页关闭维护模式。");
      } else if (error instanceof ApiRequestError && error.status === 401) {
        setConfirmation(null);
        authRequiredRef.current();
      } else if (error instanceof ApiRequestError && error.status === 403) {
        setDecisionError("你没有权限处理这个板块的审核事项。");
      } else if (error instanceof ApiRequestError && error.code === "INVALID_CSRF_TOKEN") {
        setDecisionError("会话安全令牌已失效，请刷新页面后重试。");
      } else if (error instanceof ApiRequestError && (error.status === 404 || error.status === 409)) {
        setDecisionError("这条事项已处理或不再可访问；请刷新队列。");
      } else {
        setDecisionError("决定没有提交成功，请检查网络后重试。");
      }
    } finally {
      setDecisionBusy(false);
    }
  };

  return (
    <main className="review-page" id="main-content">
      <header className="review-hero">
        <div>
          <p className="eyebrow">STAFF · 审核工作台</p>
          <h1>把需要判断的事，一件件看清楚</h1>
          <p>这里只显示待处理事项。批准或驳回前，请结合上下文与板块规则判断。</p>
        </div>
        <button className="button button-secondary" onClick={onExit} type="button">返回社区</button>
      </header>

      <section className="review-toolbar" aria-label="审核筛选">
        <label>
          <span>事项类型</span>
          <select value={typeFilter} onChange={(event) => setTypeFilter(event.target.value as "all" | ReviewType)}>
            <option value="all">全部类型</option>
            {REVIEW_TYPES.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </label>
        <label>
          <span>管理板块</span>
          <select disabled={!capabilities} value={categoryFilter} onChange={(event) => setCategoryFilter(event.target.value)}>
            <option value="all">{capabilities ? "全部可管理板块" : "正在读取权限范围…"}</option>
            {availableCategories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
          </select>
        </label>
        <button className="review-refresh" disabled={status === "loading"} onClick={() => setRefreshVersion((value) => value + 1)} type="button">
          <span aria-hidden="true">↻</span> 刷新队列
        </button>
        {capabilities && (
          <p className="review-scope" role="status">
            {capabilities.scope === "global"
              ? "全站审核权限"
              : `仅显示你负责的 ${capabilities.categoryIds.length} 个板块`}
          </p>
        )}
      </section>

      {status === "loading" && <ReviewLoading />}
      {status === "error" && (
        <ReviewError
          failure={failure}
          onExit={onExit}
          onRetry={() => setRefreshVersion((value) => value + 1)}
        />
      )}
      {status === "ready" && items.length === 0 && <ReviewEmpty onRefresh={() => setRefreshVersion((value) => value + 1)} />}
      {status === "ready" && items.length > 0 && (
        <section aria-label="待审核事项" className="review-list">
          <div className="review-list-heading">
            <strong>{items.length} 件待判断事项</strong>
            <span>按服务端优先级排列</span>
          </div>
          {items.map((item) => (
            <ReviewCard
              item={item}
              key={item.id}
              onDecision={(decision) => openConfirmation(item, decision)}
            />
          ))}
          {nextCursor ? (
            <button aria-busy={loadingMore} className="load-more review-load-more" disabled={loadingMore} onClick={() => void loadMore()} type="button">
              {loadingMore ? "正在载入…" : "继续载入待审核事项"}
            </button>
          ) : (
            <p className="feed-end-marker">当前筛选下的待审事项已经全部显示</p>
          )}
        </section>
      )}

      {confirmation && (
        <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && !decisionBusy && setConfirmation(null)}>
          <section aria-labelledby="decision-title" aria-modal="true" className="modal-card decision-modal" role="alertdialog">
            <button aria-label="取消审核决定" className="modal-close" disabled={decisionBusy} onClick={() => setConfirmation(null)} type="button">×</button>
            <p className="eyebrow">最后确认</p>
            <h2 id="decision-title">{confirmation.decision === "approve" ? "批准这条审核事项？" : "驳回这条审核事项？"}</h2>
            <p className="modal-intro">
              {confirmation.decision === "approve"
                ? "服务器会执行这类事项对应的批准动作。提交前请确认内容与上下文。"
                : "该事项会从待审核队列移除，且不会执行批准动作。"}
            </p>
            <form onSubmit={(event) => void submitDecision(event)}>
              <label className="decision-note">
                <span>内部备注 <small>可选 · {note.length}/1000</small></span>
                <textarea
                  autoFocus
                  disabled={decisionBusy}
                  maxLength={1000}
                  onChange={(event) => { setNote(event.target.value); setDecisionError(""); }}
                  placeholder="简要记录判断依据，便于后续追溯。"
                  rows={4}
                  value={note}
                />
              </label>
              {decisionError && <div className="compose-error" role="alert"><span aria-hidden="true">!</span>{decisionError}</div>}
              <div className="modal-actions">
                <button className="button button-quiet" disabled={decisionBusy} onClick={() => setConfirmation(null)} type="button">再看一下</button>
                <button
                  aria-busy={decisionBusy}
                  className={confirmation.decision === "approve" ? "button button-primary" : "button button-danger"}
                  disabled={decisionBusy}
                  type="submit"
                >
                  {decisionBusy ? "正在提交…" : confirmation.decision === "approve" ? "确认批准" : "确认驳回"}
                </button>
              </div>
            </form>
          </section>
        </div>
      )}
    </main>
  );
}

function ReviewCard({ item, onDecision }: { item: ReviewItem; onDecision: (decision: Decision) => void }) {
  const report = readReportSnapshot(item.snapshot);
  return (
    <article className="review-card">
      <div className="review-card-rail" aria-hidden="true"><span>优先级</span><strong>{item.priority}</strong></div>
      <div className="review-card-main">
        <header>
          <div className="review-badges">
            <span className={`review-type review-type-${item.type}`}>{reviewTypeLabel(item.type)}</span>
            {item.category && <span>{item.category.name}</span>}
            {report.reportType && <span>{REPORT_TYPE_LABELS[report.reportType] ?? report.reportType}</span>}
          </div>
          <time dateTime={item.createdAt}>{formatReviewTime(item.createdAt)}</time>
        </header>
        <h2>{item.target.title ?? (item.type === "registration" ? "新成员注册申请" : "待审核内容")}</h2>
        <p className="review-trigger">{item.triggerReason}</p>
        {item.target.excerpt && <blockquote>{item.target.excerpt}</blockquote>}
        {report.detail && <p className="review-report-detail"><strong>举报说明</strong>{report.detail}</p>}
        <footer>
          <div className="review-context">
            <span>{item.submittedBy ? `由 ${item.submittedBy.displayName}（@${item.submittedBy.username}）提交` : "系统规则触发"}</span>
            {item.target.postNumber !== null && <span>帖子 #{item.target.postNumber}</span>}
          </div>
          <div className="review-actions">
            <button className="button button-quiet" onClick={() => onDecision("reject")} type="button">驳回</button>
            <button className="button button-primary" onClick={() => onDecision("approve")} type="button">批准</button>
          </div>
        </footer>
      </div>
    </article>
  );
}

function ReviewLoading() {
  return (
    <div aria-busy="true" aria-live="polite" className="review-state-stack">
      <p className="visually-hidden">正在载入审核队列</p>
      {[0, 1, 2].map((item) => (
        <div className="review-skeleton" key={item}>
          <div className="skeleton-line skeleton-short" />
          <div className="skeleton-line skeleton-title" />
          <div className="skeleton-line" />
          <div className="skeleton-line skeleton-medium" />
        </div>
      ))}
    </div>
  );
}

function ReviewEmpty({ onRefresh }: { onRefresh: () => void }) {
  return (
    <section className="review-state review-empty">
      <div aria-hidden="true">✓</div>
      <h2>这一栏已经处理完了</h2>
      <p>当前筛选下没有待审核事项。新的举报或规则触发内容会自动出现在这里。</p>
      <button className="button button-secondary" onClick={onRefresh} type="button">再检查一次</button>
    </section>
  );
}

function ReviewError({
  failure,
  onExit,
  onRetry,
}: {
  failure: FailureKind | null;
  onExit: () => void;
  onRetry: () => void;
}) {
  const permission = failure === "permission";
  const authentication = failure === "authentication";
  return (
    <section className="review-state review-error" role="alert">
      <div aria-hidden="true">!</div>
      <h2>{permission ? "这个账号没有审核权限" : authentication ? "登录状态已经失效" : "审核队列暂时没有送达"}</h2>
      <p>
        {permission
          ? "版主只能处理自己负责板块的内容；若职责刚有调整，请重新登录后再试。"
          : authentication
            ? "请在登录窗口完成验证，然后重新打开审核工作台。"
            : "请检查网络或 Worker 状态。当前筛选条件会保留。"}
      </p>
      <button className="button button-secondary" onClick={permission || authentication ? onExit : onRetry} type="button">
        {permission || authentication ? "返回社区" : "重新载入"}
      </button>
    </section>
  );
}
