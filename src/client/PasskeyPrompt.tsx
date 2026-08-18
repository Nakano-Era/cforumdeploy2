import { startRegistration } from "@simplewebauthn/browser";
import { useState } from "react";
import { ApiRequestError, isSiteMaintenanceError } from "./api";
import {
  getPasskeyRegistrationOptions,
  verifyPasskeyRegistration,
} from "./auth";

interface PasskeyPromptProps {
  csrfToken: string | null;
  onComplete: () => void;
  onDismiss: () => void;
  onSessionExpired: () => void;
}

export default function PasskeyPrompt({
  csrfToken,
  onComplete,
  onDismiss,
  onSessionExpired,
}: PasskeyPromptProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const configure = async () => {
    setError("");
    if (!csrfToken) {
      setError("会话安全令牌不可用，请刷新页面后再设置。");
      return;
    }
    if (!("PublicKeyCredential" in window)) {
      setError("这个浏览器暂不支持 Passkey，可以稍后换一台设备设置。");
      return;
    }

    setBusy(true);
    try {
      const issued = await getPasskeyRegistrationOptions(csrfToken);
      const credential = await startRegistration({ optionsJSON: issued.options });
      await verifyPasskeyRegistration(
        issued.challengeId,
        credential,
        csrfToken,
        "注册时添加的设备",
      );
      onComplete();
    } catch (requestError) {
      if (isSiteMaintenanceError(requestError)) {
        setError("站点正在维护；不影响继续阅读，请稍后再设置 Passkey。");
      } else if (requestError instanceof ApiRequestError) {
        if (requestError.status === 401 || requestError.code === "INVALID_CSRF_TOKEN") {
          setError("登录状态已经失效，请重新登录后设置 Passkey。");
          onSessionExpired();
        } else if (requestError.code === "PASSKEY_REGISTRATION_FAILED") {
          setError("设备没有完成 Passkey 创建，请重新尝试或稍后设置。");
        } else if (requestError.code === "ACCOUNT_NOT_ELIGIBLE") {
          setError("当前账号状态暂时不能添加 Passkey。");
        } else {
          setError("Passkey 服务暂时不可用，可以稍后再设置。");
        }
      } else if (
        requestError instanceof Error &&
        (requestError.name === "NotAllowedError" || requestError.name === "AbortError")
      ) {
        setError("Passkey 设置已取消，不影响你继续使用社区。");
      } else {
        setError("无法启动 Passkey 设置，可以稍后再试。");
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside className="passkey-prompt" aria-labelledby="passkey-prompt-title">
      <span className="passkey-prompt-symbol" aria-hidden="true">钥</span>
      <div>
        <p className="eyebrow">强烈建议 · 不阻断使用</p>
        <h2 id="passkey-prompt-title">现在设置 Passkey，下次登录更快也更安全</h2>
        <p>使用设备解锁代替密码；你也可以先浏览社区，稍后再设置。</p>
        {error && <small role="alert">{error}</small>}
      </div>
      <div className="passkey-prompt-actions">
        <button className="button button-primary" disabled={busy} onClick={() => void configure()} type="button">
          {busy ? "等待设备确认…" : "现在设置"}
        </button>
        <button className="button button-quiet" disabled={busy} onClick={onDismiss} type="button">稍后提醒</button>
      </div>
    </aside>
  );
}
