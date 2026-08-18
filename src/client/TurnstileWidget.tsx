import { useEffect, useRef } from "react";

interface TurnstileApi {
  render(
    container: HTMLElement,
    options: {
      sitekey: string;
      action: string;
      theme: "light" | "dark";
      callback: (token: string) => void;
      "expired-callback": () => void;
      "error-callback": () => void;
    },
  ): string;
  remove(widgetId: string): void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

const SCRIPT_ID = "cforum-turnstile-script";
let loadingTurnstile: Promise<TurnstileApi> | null = null;

function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  if (loadingTurnstile) return loadingTurnstile;

  loadingTurnstile = new Promise<TurnstileApi>((resolve, reject) => {
    const finish = () => {
      if (window.turnstile) resolve(window.turnstile);
      else reject(new Error("Turnstile API unavailable"));
    };
    const existing = document.getElementById(SCRIPT_ID) as HTMLScriptElement | null;
    if (existing) {
      existing.addEventListener("load", finish, { once: true });
      existing.addEventListener(
        "error",
        () => reject(new Error("Turnstile script failed")),
        { once: true },
      );
      return;
    }

    const script = document.createElement("script");
    script.id = SCRIPT_ID;
    script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    script.async = true;
    script.defer = true;
    script.addEventListener("load", finish, { once: true });
    script.addEventListener(
      "error",
      () => reject(new Error("Turnstile script failed")),
      { once: true },
    );
    document.head.appendChild(script);
  }).catch((error: unknown) => {
    loadingTurnstile = null;
    throw error;
  });

  return loadingTurnstile;
}

interface TurnstileWidgetProps {
  action: "email_request_code" | "registration_submit";
  resetKey: number;
  siteKey: string | null;
  theme: "light" | "dark";
  onError: () => void;
  onToken: (token: string | null) => void;
}

export default function TurnstileWidget({
  action,
  resetKey,
  siteKey,
  theme,
  onError,
  onToken,
}: TurnstileWidgetProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const onErrorRef = useRef(onError);
  const onTokenRef = useRef(onToken);

  useEffect(() => {
    onErrorRef.current = onError;
    onTokenRef.current = onToken;
  }, [onError, onToken]);

  useEffect(() => {
    if (!siteKey || !containerRef.current) {
      onTokenRef.current(null);
      return;
    }

    let disposed = false;
    let widgetId: string | null = null;
    onTokenRef.current(null);
    void loadTurnstile()
      .then((turnstile) => {
        if (disposed || !containerRef.current) return;
        widgetId = turnstile.render(containerRef.current, {
          sitekey: siteKey,
          action,
          theme,
          callback: (token) => onTokenRef.current(token),
          "expired-callback": () => onTokenRef.current(null),
          "error-callback": () => {
            onTokenRef.current(null);
            onErrorRef.current();
          },
        });
      })
      .catch(() => {
        if (!disposed) onErrorRef.current();
      });

    return () => {
      disposed = true;
      if (widgetId && window.turnstile) window.turnstile.remove(widgetId);
    };
  }, [action, resetKey, siteKey, theme]);

  if (!siteKey) {
    return (
      <div className="turnstile-unavailable" role="status">
        此站点尚未配置 Turnstile，暂时无法发送验证码或提交注册。
      </div>
    );
  }

  return <div className="turnstile-widget" ref={containerRef} />;
}
