import { useState, type FormEvent } from "react";
import { ApiRequestError, isSiteMaintenanceError } from "./api";
import {
  submitPostReport,
  type ReportType,
  type SubmitReportResponse,
} from "./moderation";

const REPORT_OPTIONS: ReadonlyArray<{
  value: ReportType;
  label: string;
  description: string;
}> = [
  { value: "off_topic", label: "偏离主题", description: "与当前讨论没有直接关系" },
  { value: "inappropriate", label: "不当内容", description: "冒犯、骚扰或破坏社区氛围" },
  { value: "spam", label: "垃圾信息", description: "广告、刷屏或欺骗性内容" },
  { value: "illegal", label: "涉嫌违法", description: "可能需要优先核查的违法内容" },
  { value: "other", label: "其他问题", description: "不属于以上类型的具体问题" },
];

interface ReportDialogProps {
  postId: string;
  topicTitle: string;
  csrfToken: string | null;
  onAuthenticationRequired: () => void;
  onClose: () => void;
  onReported: (response: SubmitReportResponse) => void;
}

function reportErrorMessage(error: unknown): string {
  if (isSiteMaintenanceError(error)) return "站点正在维护，暂时只开放阅读；请稍后再提交举报。";
  if (error instanceof ApiRequestError) {
    if (error.status === 403) return "当前账号状态不能提交举报。";
    if (error.status === 404) return "这篇内容已不存在，或你不再有权查看。";
    if (error.code === "INVALID_CSRF_TOKEN") return "会话安全令牌已失效，请刷新页面后重试。";
    if (error.status === 422) return "举报说明没有通过校验，请检查后重试。";
  }
  return "举报暂时没有送达，请检查网络后重试。";
}

export default function ReportDialog({
  postId,
  topicTitle,
  csrfToken,
  onAuthenticationRequired,
  onClose,
  onReported,
}: ReportDialogProps) {
  const [type, setType] = useState<ReportType>("inappropriate");
  const [detail, setDetail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    const trimmedDetail = detail.trim();
    if ((type === "illegal" || type === "other") && !trimmedDetail) {
      setError("“涉嫌违法”和“其他问题”需要补充具体说明。");
      return;
    }
    if (!csrfToken) {
      setError("会话安全令牌不可用，请刷新页面后重试。");
      return;
    }

    setBusy(true);
    setError("");
    try {
      const response = await submitPostReport(
        postId,
        { type, detail: trimmedDetail },
        csrfToken,
      );
      onReported(response);
    } catch (requestError) {
      if (requestError instanceof ApiRequestError && requestError.status === 401) {
        onAuthenticationRequired();
        return;
      }
      setError(reportErrorMessage(requestError));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && !busy && onClose()}>
      <section aria-labelledby="report-title" aria-modal="true" className="modal-card report-modal" role="dialog">
        <button aria-label="关闭举报窗口" className="modal-close" disabled={busy} onClick={onClose} type="button">×</button>
        <p className="eyebrow">帮助版务了解情况</p>
        <h2 id="report-title">举报这篇主题的首帖</h2>
        <p className="modal-intro report-target">“{topicTitle}”</p>

        <form onSubmit={(event) => void submit(event)}>
          <fieldset className="report-options">
            <legend>选择最贴近的问题类型</legend>
            {REPORT_OPTIONS.map((option) => (
              <label className={type === option.value ? "report-option is-selected" : "report-option"} key={option.value}>
                <input
                  checked={type === option.value}
                  disabled={busy}
                  name="report-type"
                  onChange={() => { setType(option.value); setError(""); }}
                  type="radio"
                  value={option.value}
                />
                <span>
                  <strong>{option.label}</strong>
                  <small>{option.description}</small>
                </span>
              </label>
            ))}
          </fieldset>

          <label className="report-detail">
            <span>
              补充说明
              <small>{type === "illegal" || type === "other" ? "必填" : "可选"} · {detail.length}/1000</small>
            </span>
            <textarea
              autoFocus
              disabled={busy}
              maxLength={1000}
              onChange={(event) => { setDetail(event.target.value); setError(""); }}
              placeholder="请描述具体位置或问题，避免包含无关的个人信息。"
              required={type === "illegal" || type === "other"}
              rows={5}
              value={detail}
            />
          </label>

          <p className="report-idempotency">
            <span aria-hidden="true">✓</span>
            同一账号对同一内容、同一问题类型的重复举报会安全合并，不会重复创建审核事项。
          </p>
          {error && <div className="compose-error" role="alert"><span aria-hidden="true">!</span>{error}</div>}
          <div className="modal-actions">
            <button className="button button-quiet" disabled={busy} onClick={onClose} type="button">取消</button>
            <button aria-busy={busy} className="button button-primary" disabled={busy} type="submit">
              {busy ? "正在提交…" : "提交给版务"}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
