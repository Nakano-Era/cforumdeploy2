import { startAuthentication } from "@simplewebauthn/browser";
import { useEffect, useState, type FormEvent } from "react";
import { ApiRequestError, type PublicSiteConfig } from "./api";
import {
  consumeEmailLogin,
  getPasskeyAuthenticationOptions,
  registerAccount,
  requestEmailCode,
  verifyEmailCode,
  verifyPasskeyAuthentication,
  type AuthenticatedResponse,
  type EmailAuthPurpose,
  type EmailCodeVerificationResponse,
} from "./auth";
import TurnstileWidget from "./TurnstileWidget";

type AuthStage = "choose" | "email" | "code" | "register";

function inviteTokenFromLocation(): string {
  if (typeof window === "undefined") return "";
  return new URL(window.location.href).searchParams.get("invite")?.trim() ?? "";
}

function clearInviteTokenFromLocation(): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (!url.searchParams.has("invite")) return;
  url.searchParams.delete("invite");
  window.history.replaceState(
    window.history.state,
    "",
    `${url.pathname}${url.search}${url.hash}`,
  );
}

interface AuthDialogProps {
  siteConfig: PublicSiteConfig;
  theme: "light" | "dark";
  onAuthenticated: (
    session: AuthenticatedResponse,
    context: { newRegistration: boolean },
  ) => void;
  onClose: () => void;
  onRegistrationPending: () => void;
}

function messageForError(error: unknown, context: "passkey" | "email" | "code" | "register"): string {
  if (error instanceof ApiRequestError) {
    switch (error.code) {
      case "TURNSTILE_FAILED":
        return "人机验证已失效，请重新完成验证后再试。";
      case "INVALID_OR_EXPIRED_VERIFICATION_CODE":
        return "验证码不正确或已经过期，请检查后重试。";
      case "INVALID_OR_EXPIRED_VERIFICATION_TICKET":
        return "这次邮箱验证已经失效，请重新获取验证码。";
      case "INVALID_PASSKEY_AUTHENTICATION":
        return "没有完成 Passkey 验证，请确认使用的是这个站点的凭证。";
      case "PASSKEY_SERVICE_UNAVAILABLE":
        return "Passkey 服务暂时不可用，请改用邮箱验证码。";
      case "AUTH_SERVICE_UNAVAILABLE":
        return "邮箱认证服务暂时不可用，请稍后重试。";
      case "REGISTRATION_NOT_AVAILABLE":
        return "站点当前没有开放注册。";
      case "SITE_MAINTENANCE":
        return "站点正在维护，暂时只开放阅读；现有成员仍可登录。";
      case "INVITATION_REQUIRED":
        return "当前仅限邀请注册，请填写有效邀请码。";
      case "INVITATION_INVALID":
        return "邀请码无效、已过期或不适用于这个邮箱。";
      case "REGISTRATION_CONFLICT":
        return "用户名或邮箱已被使用，请更换后再试。";
      case "INVALID_INPUT":
        return "提交的信息格式不正确，请检查各字段。";
    }
  }
  if (error instanceof Error && (error.name === "NotAllowedError" || error.name === "AbortError")) {
    return "Passkey 操作已取消，你仍可以改用邮箱验证码。";
  }
  if (context === "passkey") return "无法启动 Passkey，请改用邮箱验证码。";
  if (context === "register") return "注册没有完成，请检查连接后重试。";
  if (context === "code") return "验证码没有完成验证，请稍后重试。";
  return "验证码请求没有送达服务器，请稍后重试。";
}

export default function AuthDialog({
  siteConfig,
  theme,
  onAuthenticated,
  onClose,
  onRegistrationPending,
}: AuthDialogProps) {
  const [inviteToken, setInviteToken] = useState(inviteTokenFromLocation);
  const [stage, setStage] = useState<AuthStage>(() => inviteToken ? "email" : "choose");
  const [purpose, setPurpose] = useState<EmailAuthPurpose>(() => inviteToken ? "register" : "login");
  const [email, setEmail] = useState("");
  const [challengeId, setChallengeId] = useState("");
  const [code, setCode] = useState("");
  const [verification, setVerification] =
    useState<EmailCodeVerificationResponse | null>(null);
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [turnstileResetKey, setTurnstileResetKey] = useState(0);
  const [resendSeconds, setResendSeconds] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");

  useEffect(() => {
    if (stage !== "code" || resendSeconds <= 0) return;
    const timer = window.setInterval(
      () => setResendSeconds((seconds) => Math.max(0, seconds - 1)),
      1000,
    );
    return () => window.clearInterval(timer);
  }, [resendSeconds, stage]);

  const resetTurnstile = () => {
    setTurnstileToken(null);
    setTurnstileResetKey((key) => key + 1);
  };

  const choosePurpose = (nextPurpose: EmailAuthPurpose) => {
    setPurpose(nextPurpose);
    setError("");
    setInfo("");
    resetTurnstile();
  };

  const beginPasskey = async () => {
    setError("");
    setInfo("");
    if (!("PublicKeyCredential" in window)) {
      setError("这个浏览器不支持 Passkey，请改用邮箱验证码。");
      return;
    }
    setBusy(true);
    try {
      const issued = await getPasskeyAuthenticationOptions();
      const credential = await startAuthentication({ optionsJSON: issued.options });
      const session = await verifyPasskeyAuthentication(
        issued.challengeId,
        credential,
      );
      onAuthenticated(session, { newRegistration: false });
    } catch (requestError) {
      setError(messageForError(requestError, "passkey"));
    } finally {
      setBusy(false);
    }
  };

  const sendCode = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError("");
    setInfo("");
    if (purpose === "register" && (siteConfig.registrationFrozen || siteConfig.maintenanceMode)) {
      setError(siteConfig.maintenanceMode
        ? "站点正在维护，暂时只开放阅读；请在维护结束后注册。"
        : "站点管理员已暂时冻结新注册。");
      return;
    }
    if (!turnstileToken) {
      setError("请先完成人机验证。");
      return;
    }
    setBusy(true);
    try {
      const response = await requestEmailCode({
        email: email.trim(),
        purpose,
        turnstileToken,
      });
      setChallengeId(response.challengeId);
      setResendSeconds(response.resendAfterSeconds);
      setCode("");
      setTurnstileToken(null);
      setInfo("如果该邮箱符合当前操作条件，八位验证码会在几分钟内送达。为保护账号，我们不会透露邮箱是否已注册。");
      setStage("code");
    } catch (requestError) {
      if (requestError instanceof ApiRequestError && requestError.code === "TURNSTILE_FAILED") {
        resetTurnstile();
      }
      setError(messageForError(requestError, "email"));
    } finally {
      setBusy(false);
    }
  };

  const verifyCodeAndContinue = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      const verified = await verifyEmailCode({
        challengeId,
        email: email.trim(),
        code,
      });
      setCode("");
      setVerification(verified);

      if (verified.purpose === "login") {
        const session = await consumeEmailLogin({
          challengeId: verified.challengeId,
          email: verified.email,
          verificationTicket: verified.verificationTicket,
        });
        setVerification(null);
        onAuthenticated(session, { newRegistration: false });
        return;
      }

      resetTurnstile();
      setStage("register");
      setInfo("邮箱验证成功。再设置用户名和显示名称即可完成注册。");
    } catch (requestError) {
      setError(messageForError(requestError, "code"));
    } finally {
      setBusy(false);
    }
  };

  const submitRegistration = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError("");
    if (!verification || verification.purpose !== "register") {
      setError("邮箱验证已经失效，请重新开始注册。");
      return;
    }
    if (!/^[\p{L}\p{N}_-]{3,32}$/u.test(username.trim())) {
      setError("用户名需为 3–32 个汉字、字母、数字、下划线或连字符。");
      return;
    }
    if (siteConfig.registrationMode === "invite_only" && !inviteToken.trim()) {
      setError("当前仅限邀请注册，请填写邀请码。");
      return;
    }
    if (!turnstileToken) {
      setError("请先完成人机验证。");
      return;
    }

    setBusy(true);
    try {
      const response = await registerAccount({
        email: verification.email,
        challengeId: verification.challengeId,
        verificationTicket: verification.verificationTicket,
        username: username.trim(),
        displayName: displayName.trim(),
        ...(inviteToken.trim() ? { inviteToken: inviteToken.trim() } : {}),
        turnstileToken,
      });
      setVerification(null);
      setTurnstileToken(null);
      clearInviteTokenFromLocation();
      if (
        response.registration.status === "active" &&
        response.user &&
        response.csrfToken
      ) {
        onAuthenticated(
          { user: response.user, csrfToken: response.csrfToken },
          { newRegistration: true },
        );
      } else {
        onRegistrationPending();
      }
    } catch (requestError) {
      if (requestError instanceof ApiRequestError && requestError.code === "TURNSTILE_FAILED") {
        resetTurnstile();
      }
      setError(messageForError(requestError, "register"));
    } finally {
      setBusy(false);
    }
  };

  const restartEmail = () => {
    setStage("email");
    setChallengeId("");
    setVerification(null);
    setCode("");
    setError("");
    setInfo("");
    resetTurnstile();
  };

  const registrationDisabled = siteConfig.registrationFrozen || siteConfig.maintenanceMode;
  const registrationLabel =
    siteConfig.registrationMode === "invite_only"
      ? "注册 · 需要邀请"
      : siteConfig.registrationMode === "approval"
        ? "申请加入"
        : "创建账号";

  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section aria-labelledby="login-title" aria-modal="true" className="modal-card login-modal auth-dialog" role="dialog">
        <button aria-label="关闭登录窗口" className="modal-close" onClick={onClose} type="button">×</button>

        <div className="auth-heading">
          <p className="eyebrow">
            {stage === "register" ? "创建社区身份" : stage === "choose" ? "欢迎回来" : "邮箱验证"}
          </p>
          <h2 id="login-title">
            {stage === "choose" && "继续你的社区对话"}
            {stage === "email" && "用邮箱继续"}
            {stage === "code" && "输入八位验证码"}
            {stage === "register" && "最后一步，介绍一下自己"}
          </h2>
          <p className="modal-intro">
            {stage === "choose" && "优先使用设备上的 Passkey，也可以通过邮箱完成登录或注册。"}
            {stage === "email" && "选择这次要登录还是注册；服务器始终使用一致响应保护账号隐私。"}
            {stage === "code" && `验证码发送至 ${email.trim()}（若该邮箱符合条件）`}
            {stage === "register" && `${verification?.email ?? email} 已通过邮箱验证`}
          </p>
        </div>

        {stage === "choose" && (
          <div className="auth-choose">
            <button autoFocus className="auth-option passkey-option" disabled={busy} onClick={() => void beginPasskey()} type="button">
              <span className="auth-symbol" aria-hidden="true">钥</span>
              <span><strong>{busy ? "正在等待 Passkey…" : "使用 Passkey 登录"}</strong><small>使用指纹、面容或设备解锁</small></span>
              <span aria-hidden="true">→</span>
            </button>
            <div className="auth-divider"><span>或者</span></div>
            <button className="auth-option" disabled={busy} onClick={() => setStage("email")} type="button">
              <span className="auth-symbol" aria-hidden="true">邮</span>
              <span><strong>使用邮箱验证码</strong><small>登录已有账号，或验证邮箱注册</small></span>
              <span aria-hidden="true">→</span>
            </button>
          </div>
        )}

        {stage === "email" && (
          <form className="auth-form" onSubmit={(event) => void sendCode(event)}>
            <div className="auth-intent" role="group" aria-label="邮箱操作">
              <button className={purpose === "login" ? "is-selected" : ""} onClick={() => choosePurpose("login")} type="button">登录已有账号</button>
              <button
                className={purpose === "register" ? "is-selected" : ""}
                disabled={registrationDisabled}
                onClick={() => choosePurpose("register")}
                type="button"
              >
                {registrationLabel}
              </button>
            </div>
            {registrationDisabled && (
              <p className="auth-policy-note">
                {siteConfig.maintenanceMode
                  ? "站点正在维护，暂时只开放阅读；现有成员仍可登录。"
                  : "站点管理员已暂时冻结新注册，现有成员仍可登录。"}
              </p>
            )}
            <label className="auth-field">
              <span>邮箱地址</span>
              <input autoComplete="email" autoFocus maxLength={254} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" required type="email" value={email} />
            </label>
            <TurnstileWidget
              action="email_request_code"
              onError={() => setError("人机验证无法载入，请检查网络与 Turnstile 配置。")}
              onToken={setTurnstileToken}
              resetKey={turnstileResetKey}
              siteKey={siteConfig.turnstileSiteKey}
              theme={theme}
            />
            <button className="button button-primary auth-submit" disabled={busy || !siteConfig.turnstileSiteKey} type="submit">
              {busy ? "正在请求…" : "发送八位验证码"}
            </button>
            <button className="auth-back" onClick={() => { setStage("choose"); setError(""); }} type="button">← 返回其他登录方式</button>
          </form>
        )}

        {stage === "code" && (
          <form className="auth-form" onSubmit={(event) => void verifyCodeAndContinue(event)}>
            {info && <div className="auth-info" role="status">{info}</div>}
            <label className="auth-field code-field">
              <span>八位验证码</span>
              <input autoComplete="one-time-code" autoFocus inputMode="numeric" maxLength={8} minLength={8} onChange={(event) => setCode(event.target.value.replace(/\D/g, ""))} pattern="[0-9]{8}" placeholder="00000000" required value={code} />
            </label>
            <button className="button button-primary auth-submit" disabled={busy || code.length !== 8} type="submit">
              {busy ? "正在验证…" : purpose === "login" ? "验证并登录" : "验证并继续注册"}
            </button>
            <button className="auth-back" disabled={resendSeconds > 0} onClick={restartEmail} type="button">
              {resendSeconds > 0 ? `${resendSeconds} 秒后可重新发送` : "重新发送或更换邮箱"}
            </button>
          </form>
        )}

        {stage === "register" && (
          <form className="auth-form" onSubmit={(event) => void submitRegistration(event)}>
            {info && <div className="auth-info success-info" role="status">{info}</div>}
            <div className="auth-field-row">
              <label className="auth-field">
                <span>用户名</span>
                <input autoComplete="username" autoFocus maxLength={32} minLength={3} onChange={(event) => setUsername(event.target.value)} placeholder="linmo" required value={username} />
              </label>
              <label className="auth-field">
                <span>显示名称</span>
                <input autoComplete="name" maxLength={80} onChange={(event) => setDisplayName(event.target.value)} placeholder="林默" required value={displayName} />
              </label>
            </div>
            <label className="auth-field">
              <span>
                邀请码
                <small>{siteConfig.registrationMode === "invite_only" ? "必填" : "如有可填写"}</small>
              </span>
              <input autoComplete="off" minLength={16} onChange={(event) => setInviteToken(event.target.value)} placeholder="粘贴邀请链接中的 token" required={siteConfig.registrationMode === "invite_only"} value={inviteToken} />
            </label>
            <div className="auth-registration-note">
              {siteConfig.registrationMode === "approval" && "提交后将进入审核队列，批准后即可登录。"}
              {siteConfig.registrationMode === "open" && "注册完成后会直接登录，并强提示设置 Passkey。"}
              {siteConfig.registrationMode === "invite_only" && "有效邀请默认直接启用；站点也可能要求额外审核。"}
            </div>
            <TurnstileWidget
              action="registration_submit"
              onError={() => setError("人机验证无法载入，请检查网络与 Turnstile 配置。")}
              onToken={setTurnstileToken}
              resetKey={turnstileResetKey}
              siteKey={siteConfig.turnstileSiteKey}
              theme={theme}
            />
            <button className="button button-primary auth-submit" disabled={busy || !siteConfig.turnstileSiteKey} type="submit">
              {busy ? "正在提交…" : siteConfig.registrationMode === "approval" ? "提交加入申请" : "完成注册"}
            </button>
          </form>
        )}

        {error && <div className="auth-error" role="alert"><span aria-hidden="true">!</span>{error}</div>}
        <p className="security-note"><span aria-hidden="true">盾</span> Passkey、一次性验证码与 Turnstile 共同保护登录</p>
      </section>
    </div>
  );
}
