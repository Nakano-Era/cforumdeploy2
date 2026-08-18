import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
} from "react";
import {
  ApiRequestError,
  bootstrapSite,
  getBootstrapStatus,
  getPublicSiteConfig,
  isSiteMaintenanceError,
  type BootstrapRequest,
  type BootstrapSuccessResponse,
  type PublicSiteConfig,
  type RegistrationMode,
} from "./api";
import AuthDialog from "./AuthDialog";
import AdminWorkspace from "./AdminWorkspace";
import ComposeDialog from "./ComposeDialog";
import NotificationPanel from "./NotificationPanel";
import PasskeyPrompt from "./PasskeyPrompt";
import ProfileDialog from "./ProfileDialog";
import ReportDialog from "./ReportDialog";
import ReviewWorkspace from "./ReviewWorkspace";
import TopicDetail from "./TopicDetail";
import {
  getAuthSession,
  readCsrfCookie,
  type AuthenticatedResponse,
  type AuthUser,
} from "./auth";
import {
  getDemoFeed,
  getFeed,
  type CategorySummary,
  type FeedQuery,
  type FeedResponse,
  type FeedTab,
  type FeedTopic,
  type FeedViewer,
  type TrustLevel,
  type TopicVisibility,
} from "./feed";
import { setPostBookmark } from "./forum";
import { shouldDismissDialogOnEscape } from "./dialogDismissal";

type Theme = "light" | "dark";
type FeedStatus = "ready" | "loading" | "error";
type InstallationStatus = "checking" | "required" | "installed" | "error";
type LevelFilter = "all" | "0" | "1" | "2" | "3" | "4";
type ActiveDialog = "login" | "compose" | "profile" | "report" | null;
type ActiveView = "feed" | "review" | "admin" | "topic";
type CommunitySection = "categories" | "community-pulse" | "community-guide";

type AppRoute =
  | { view: "feed" }
  | { view: "topic"; topicId: string; hash: string };

interface FeedFailure {
  message: string;
  authenticationRequired: boolean;
}

function routeFromLocation(): AppRoute {
  if (typeof window === "undefined") return { view: "feed" };
  const match = window.location.pathname.match(/^\/t\/([^/]+)(?:\/[^/]*)?\/?$/);
  if (!match?.[1]) return { view: "feed" };
  try {
    return {
      view: "topic",
      topicId: decodeURIComponent(match[1]),
      hash: window.location.hash,
    };
  } catch {
    return { view: "feed" };
  }
}

function communitySectionFromHash(hash: string): CommunitySection | null {
  const section = hash.startsWith("#") ? hash.slice(1) : hash;
  return section === "categories" ||
    section === "community-pulse" ||
    section === "community-guide"
    ? section
    : null;
}

function isPlainLeftClick(event: { button: number; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

const DEMO_MODE =
  import.meta.env.DEV && import.meta.env.VITE_DEMO_MODE === "true";

const TAB_OPTIONS: ReadonlyArray<{ id: FeedTab; label: string; hint: string }> = [
  { id: "all", label: "综合", hint: "站务置顶与最新讨论" },
  { id: "latest", label: "最新", hint: "按最近活动排序" },
  { id: "hot", label: "热门", hint: "近期高质量讨论" },
  { id: "following", label: "关注", hint: "你关注的板块和主题" },
  { id: "unread", label: "未读", hint: "新主题与新回复" },
];

const LEVEL_OPTIONS: ReadonlyArray<{ value: LevelFilter; label: string }> = [
  { value: "all", label: "全部等级" },
  { value: "0", label: "仅公开 · Lv0" },
  { value: "1", label: "最高 Lv1" },
  { value: "2", label: "最高 Lv2" },
  { value: "3", label: "最高 Lv3" },
  { value: "4", label: "包含 Lv4" },
];

const categoryStyle = (color: string) =>
  ({ "--category-color": color }) as CSSProperties;

function resolveInitialTheme(): Theme {
  if (typeof window === "undefined") return "light";
  const stored = window.localStorage.getItem("cforum-theme");
  if (stored === "light" || stored === "dark") return stored;
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function formatCount(count: number): string {
  return count >= 1000 ? `${(count / 1000).toFixed(1)}k` : String(count);
}

function formatRelativeTime(iso: string): string {
  const elapsedMinutes = Math.max(
    1,
    Math.floor((Date.now() - new Date(iso).getTime()) / 60_000),
  );
  if (elapsedMinutes < 60) return `${elapsedMinutes} 分钟前`;
  const hours = Math.floor(elapsedMinutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  return days < 7 ? `${days} 天前` : new Date(iso).toLocaleDateString("zh-CN");
}

function buildFeedQuery(
  tab: FeedTab,
  category: string,
  level: LevelFilter,
  search: string,
  cursor?: string,
): FeedQuery {
  return {
    tab,
    ...(category !== "all" ? { category } : {}),
    ...(level !== "all" ? { minLevel: Number(level) as TrustLevel } : {}),
    ...(search.trim().length >= 2 ? { search: search.trim() } : {}),
    ...(cursor ? { cursor } : {}),
  };
}

function describeFeedFailure(error: unknown): FeedFailure {
  if (error instanceof ApiRequestError && error.status === 401) {
    return {
      message: "登录后才能查看关注和未读内容。",
      authenticationRequired: true,
    };
  }
  if (error instanceof ApiRequestError && error.status === 422) {
    return {
      message: "筛选条件没有被服务器接受，请清除筛选后重试。",
      authenticationRequired: false,
    };
  }
  return {
    message: "请检查网络后再试。你的筛选条件仍会保留。",
    authenticationRequired: false,
  };
}

export default function App() {
  const [theme, setTheme] = useState<Theme>(resolveInitialTheme);
  const [route, setRoute] = useState<AppRoute>(routeFromLocation);
  const [installationStatus, setInstallationStatus] =
    useState<InstallationStatus>("checking");
  const [installationAttempt, setInstallationAttempt] = useState(0);
  const [initializationError, setInitializationError] = useState("");
  const [siteName, setSiteName] = useState("CForum");
  const [siteConfig, setSiteConfig] = useState<PublicSiteConfig>({
    siteName: "CForum",
    siteDescription: "认真交流的地方",
    registrationMode: "approval",
    registrationFrozen: false,
    maintenanceMode: false,
    turnstileSiteKey: null,
  });
  const [activeTab, setActiveTab] = useState<FeedTab>("all");
  const [category, setCategory] = useState("all");
  const [level, setLevel] = useState<LevelFilter>("all");
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [feed, setFeed] = useState<FeedResponse | null>(null);
  const [viewer, setViewer] = useState<FeedViewer | null>(null);
  const [authUser, setAuthUser] = useState<AuthUser | null>(null);
  const [categories, setCategories] = useState<CategorySummary[]>([]);
  const [feedStatus, setFeedStatus] = useState<FeedStatus>("loading");
  const [feedFailure, setFeedFailure] = useState<FeedFailure | null>(null);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [dialog, setDialog] = useState<ActiveDialog>(null);
  const [profileBusy, setProfileBusy] = useState(false);
  const [activeView, setActiveView] = useState<ActiveView>("feed");
  const [pendingSection, setPendingSection] = useState<CommunitySection | null>(
    () =>
      typeof window === "undefined"
        ? null
        : communitySectionFromHash(window.location.hash),
  );
  const [reportTopic, setReportTopic] = useState<FeedTopic | null>(null);
  const [showMobileFilters, setShowMobileFilters] = useState(false);
  const [showNotifications, setShowNotifications] = useState(false);
  const [bookmarks, setBookmarks] = useState<Set<string>>(() => new Set());
  const [bookmarkBusy, setBookmarkBusy] = useState<Set<string>>(() => new Set());
  const [toast, setToast] = useState<string | null>(null);
  const [showPasskeyPrompt, setShowPasskeyPrompt] = useState(false);
  const csrfTokenRef = useRef<string | null>(null);
  const loadMoreControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    window.localStorage.setItem("cforum-theme", theme);
  }, [theme]);

  useEffect(() => {
    const handlePopState = () => {
      const nextRoute = routeFromLocation();
      setRoute(nextRoute);
      setPendingSection(communitySectionFromHash(window.location.hash));
      setActiveView(
        nextRoute.view === "topic"
          ? "feed"
          : window.history.state?.cforumView === "review" || window.history.state?.cforumView === "admin"
            ? window.history.state.cforumView
            : "feed",
      );
      setDialog(null);
      setReportTopic(null);
      setShowNotifications(false);
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setInstallationStatus("checking");
    setInitializationError("");

    void (async () => {
      try {
        const status = await getBootstrapStatus(controller.signal);
        if (status.installationRequired) {
          setInstallationStatus("required");
          return;
        }
        const [config, session] = await Promise.all([
          getPublicSiteConfig(controller.signal),
          getAuthSession(controller.signal),
        ]);
        setSiteName(config.siteName);
        setSiteConfig(config);
        if (session.authenticated) {
          setAuthUser(session.user);
          setViewer({
            id: session.user.id,
            displayName: session.user.displayName,
            trustLevel: session.user.trustLevel,
            unreadNotifications: 0,
          });
          csrfTokenRef.current = readCsrfCookie();
        } else {
          setAuthUser(null);
          setViewer(null);
          csrfTokenRef.current = null;
        }
        setInstallationStatus("installed");
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setInitializationError("无法确认站点安装状态，请检查 Worker 与 D1 连接后重试。");
        setInstallationStatus("error");
      }
    })();

    return () => controller.abort();
  }, [installationAttempt]);

  useEffect(() => {
    if (!dialog) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (
        event.key === "Escape" &&
        shouldDismissDialogOnEscape(dialog, profileBusy)
      ) {
        setDialog(null);
        if (dialog === "report") setReportTopic(null);
      }
    };
    document.body.classList.add("modal-open");
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.body.classList.remove("modal-open");
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [dialog, profileBusy]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 3200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query), 360);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    if (installationStatus !== "installed") return;
    const controller = new AbortController();
    let demoTimer: number | undefined;
    loadMoreControllerRef.current?.abort();
    setLoadingMore(false);
    setFeedStatus("loading");
    setFeedFailure(null);
    setFeed(null);

    const applyResponse = (response: FeedResponse) => {
      setFeed(response);
      setViewer((current) =>
        response.viewer && current?.id === response.viewer.id
          ? { ...response.viewer, displayName: current.displayName }
          : response.viewer,
      );
      setCategories(response.categories);
      setBookmarks(
        new Set(response.topics.filter((topic) => topic.bookmarked).map((topic) => topic.id)),
      );
      setFeedStatus("ready");
    };

    const request = buildFeedQuery(
      activeTab,
      category,
      level,
      debouncedQuery,
    );

    if (DEMO_MODE) {
      demoTimer = window.setTimeout(() => applyResponse(getDemoFeed(request)), 280);
    } else {
      void getFeed(request, controller.signal)
        .then(applyResponse)
        .catch((error: unknown) => {
          if (error instanceof DOMException && error.name === "AbortError") return;
          const failure = describeFeedFailure(error);
          if (failure.authenticationRequired) {
            setAuthUser(null);
            setViewer(null);
            csrfTokenRef.current = null;
          }
          setFeedFailure(failure);
          setFeedStatus("error");
        });
    }

    return () => {
      controller.abort();
      if (demoTimer !== undefined) window.clearTimeout(demoTimer);
    };
  }, [activeTab, category, debouncedQuery, installationStatus, level, refreshVersion]);

  useEffect(() => () => loadMoreControllerRef.current?.abort(), []);

  useEffect(() => {
    if (
      !pendingSection ||
      route.view !== "feed" ||
      activeView !== "feed" ||
      !feed
    ) {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      const target = document.getElementById(pendingSection);
      if (!target) return;
      window.history.replaceState(
        { ...window.history.state, cforumView: "feed" },
        "",
        `/#${pendingSection}`,
      );
      target.focus({ preventScroll: true });
      const top = target.getBoundingClientRect().top + window.scrollY - 84;
      window.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
      setPendingSection(null);
    });

    return () => window.cancelAnimationFrame(frame);
  }, [activeView, feed, pendingSection, route.view]);

  const activeTabMeta = TAB_OPTIONS.find((tab) => tab.id === activeTab) ?? TAB_OPTIONS[0];
  const hasFilters = category !== "all" || level !== "all" || query.trim() !== "";

  const clearFilters = () => {
    setCategory("all");
    setLevel("all");
    setQuery("");
  };

  const refreshFeed = () => {
    setRefreshVersion((version) => version + 1);
  };

  const loadMore = async () => {
    if (!feed?.nextCursor || loadingMore) return;
    loadMoreControllerRef.current?.abort();
    const controller = new AbortController();
    loadMoreControllerRef.current = controller;
    setLoadingMore(true);
    try {
      const request = buildFeedQuery(
        activeTab,
        category,
        level,
        debouncedQuery,
        feed.nextCursor,
      );
      const nextPage = DEMO_MODE
        ? getDemoFeed(request)
        : await getFeed(request, controller.signal);
      setFeed((current) => {
        if (!current) return nextPage;
        const seen = new Set(current.topics.map((topic) => topic.id));
        return {
          ...nextPage,
          topics: [
            ...current.topics,
            ...nextPage.topics.filter((topic) => !seen.has(topic.id)),
          ],
        };
      });
      setBookmarks((current) => {
        const next = new Set(current);
        nextPage.topics.forEach((topic) => {
          if (topic.bookmarked) next.add(topic.id);
        });
        return next;
      });
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        setToast("更早的讨论载入失败，请稍后再试");
      }
    } finally {
      if (loadMoreControllerRef.current === controller) {
        loadMoreControllerRef.current = null;
        setLoadingMore(false);
      }
    }
  };

  const toggleBookmark = async (topic: FeedTopic) => {
    if (bookmarkBusy.has(topic.id)) return;
    if (siteConfig.maintenanceMode && authUser?.role !== "admin") {
      setToast("站点正在维护，暂时只开放阅读");
      return;
    }
    if (!authUser) {
      setToast("登录后才能收藏主题");
      setDialog("login");
      return;
    }
    const csrfToken = csrfTokenRef.current ?? readCsrfCookie();
    if (!csrfToken) {
      setToast("会话安全令牌不可用，请刷新页面后重试");
      return;
    }
    csrfTokenRef.current = csrfToken;

    const previousActive = bookmarks.has(topic.id);
    const desired = !previousActive;
    const applyState = (active: boolean) => {
      setBookmarks((current) => {
        const next = new Set(current);
        if (active) next.add(topic.id);
        else next.delete(topic.id);
        return next;
      });
    };

    setBookmarkBusy((current) => new Set(current).add(topic.id));
    applyState(desired);
    try {
      const response = await setPostBookmark(
        topic.firstPostId,
        desired,
        csrfToken,
      );
      if (response.bookmark.postId !== topic.firstPostId) {
        throw new Error("bookmark_response_mismatch");
      }
      applyState(response.bookmark.active);
      setToast(response.bookmark.active ? "已收藏这个主题" : "已取消收藏");
    } catch (requestError) {
      applyState(previousActive);
      if (isSiteMaintenanceError(requestError)) {
        setSiteConfig((current) => ({ ...current, maintenanceMode: true }));
        setToast("站点正在维护，暂时只开放阅读；收藏状态已恢复");
      } else if (requestError instanceof ApiRequestError && requestError.status === 401) {
        csrfTokenRef.current = null;
        setAuthUser(null);
        setViewer(null);
        setToast("登录状态已失效，请重新登录后收藏");
        setDialog("login");
        setRefreshVersion((version) => version + 1);
      } else if (
        requestError instanceof ApiRequestError &&
        requestError.code === "INVALID_CSRF_TOKEN"
      ) {
        setToast("会话安全令牌已失效，请刷新页面后重试");
      } else if (
        requestError instanceof ApiRequestError &&
        requestError.code === "ACCOUNT_NOT_ACTIVE"
      ) {
        setToast("当前账号状态不能收藏主题");
      } else {
        setToast(previousActive ? "取消收藏失败，已恢复原状态" : "收藏失败，已恢复原状态");
      }
    } finally {
      setBookmarkBusy((current) => {
        const next = new Set(current);
        next.delete(topic.id);
        return next;
      });
    }
  };

  const navigateToTopic = (topicId: string, postId?: string | null) => {
    const hash = postId ? `#post-${encodeURIComponent(postId)}` : "";
    const path = `/t/${encodeURIComponent(topicId)}${hash}`;
    window.history.pushState(
      { cforumRoute: "topic", returnView: activeView },
      "",
      path,
    );
    setRoute({ view: "topic", topicId, hash });
    setShowNotifications(false);
    setDialog(null);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const navigateToFeed = () => {
    if (route.view === "feed" && activeView === "feed") {
      setShowNotifications(false);
      window.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }
    window.history.pushState({ cforumView: "feed" }, "", "/");
    setRoute({ view: "feed" });
    setActiveView("feed");
    setShowNotifications(false);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const openCommunitySection = (section: CommunitySection) => {
    setPendingSection(section);
    navigateToFeed();
  };

  const openStaffWorkspace = (view: "review" | "admin") => {
    setShowNotifications(false);
    window.history.pushState({ cforumView: view }, "", "/");
    setRoute({ view: "feed" });
    setActiveView(view);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const navigateBackFromTopic = () => {
    if (window.history.state?.cforumRoute === "topic") {
      window.history.back();
      return;
    }
    navigateToFeed();
  };

  const replaceTopicHash = (topicId: string, postId: string) => {
    const hash = `#post-${encodeURIComponent(postId)}`;
    window.history.replaceState(window.history.state, "", `/t/${encodeURIComponent(topicId)}${hash}`);
    setRoute({ view: "topic", topicId, hash });
  };

  const selectTab = (tab: FeedTab) => {
    if (route.view === "topic") navigateToFeed();
    setActiveView("feed");
    setActiveTab(tab);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const openCategory = (categorySlug: string) => {
    navigateToFeed();
    setCategory(categorySlug);
    setShowMobileFilters(false);
  };

  const toggleTheme = () =>
    setTheme((value) => (value === "light" ? "dark" : "light"));

  const handleAuthenticated = (
    session: AuthenticatedResponse,
    context: { newRegistration: boolean },
  ) => {
    csrfTokenRef.current = session.csrfToken;
    setAuthUser(session.user);
    setViewer({
      id: session.user.id,
      displayName: session.user.displayName,
      trustLevel: session.user.trustLevel,
      unreadNotifications: 0,
    });
    setDialog(null);
    setShowPasskeyPrompt(context.newRegistration);
    setToast(
      context.newRegistration
        ? `欢迎加入，${session.user.displayName}`
        : `欢迎回来，${session.user.displayName}`,
    );
    setRefreshVersion((version) => version + 1);
  };

  const openCompose = () => {
    if (siteConfig.maintenanceMode && authUser?.role !== "admin") {
      setToast("站点正在维护，暂时只开放阅读；草稿不会被提交");
      return;
    }
    if (!authUser) {
      setToast("登录后才能发起讨论");
      setDialog("login");
      return;
    }
    setShowNotifications(false);
    setDialog("compose");
  };

  const openReport = (topic: FeedTopic) => {
    if (siteConfig.maintenanceMode && authUser?.role !== "admin") {
      setToast("站点正在维护，暂时只开放阅读；请稍后再提交举报");
      return;
    }
    if (!authUser) {
      setToast("登录后才能举报内容");
      setDialog("login");
      return;
    }
    const csrfToken = csrfTokenRef.current ?? readCsrfCookie();
    if (!csrfToken) {
      setToast("会话安全令牌不可用，请刷新页面后重试");
      return;
    }
    csrfTokenRef.current = csrfToken;
    setShowNotifications(false);
    setReportTopic(topic);
    setDialog("report");
  };

  const authenticationRequired = (message: string) => {
    csrfTokenRef.current = null;
    setAuthUser(null);
    setViewer(null);
    setShowPasskeyPrompt(false);
    setShowNotifications(false);
    setToast(message);
    setDialog("login");
    setRefreshVersion((version) => version + 1);
  };

  const isStaff = authUser?.role === "admin" || authUser?.role === "moderator";
  const isAdmin = authUser?.role === "admin" && authUser.status === "active";

  const toggleNotifications = () => {
    if (!authUser) {
      setToast("登录后才能查看通知");
      setDialog("login");
      return;
    }
    const csrfToken = csrfTokenRef.current ?? readCsrfCookie();
    if (csrfToken) csrfTokenRef.current = csrfToken;
    setShowNotifications((open) => !open);
  };

  if (installationStatus === "checking" || installationStatus === "error") {
    return (
      <StartupState
        error={installationStatus === "error" ? initializationError : null}
        onRetry={() => setInstallationAttempt((attempt) => attempt + 1)}
        onToggleTheme={toggleTheme}
        theme={theme}
      />
    );
  }

  if (installationStatus === "required") {
    return (
      <InstallWizard
        onInstalled={(response, input) => {
          csrfTokenRef.current = response.csrfToken;
          setAuthUser({ ...response.user, status: "active" });
          setViewer({
            id: response.user.id,
            displayName: response.user.displayName,
            trustLevel: response.user.trustLevel,
            unreadNotifications: 0,
          });
          setSiteName(input.siteName);
          setShowPasskeyPrompt(true);
          setInstallationStatus("checking");
          setInstallationAttempt((attempt) => attempt + 1);
        }}
        onToggleTheme={toggleTheme}
        theme={theme}
      />
    );
  }

  const topics = feed?.topics ?? [];
  const notificationCount = viewer?.unreadNotifications ?? 0;
  const pinnedTopic = topics.find((topic) => topic.pinned);
  const shellView: ActiveView = route.view === "topic" ? "topic" : activeView;

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        跳到主要内容
      </a>

      <TopBar
        activeView={shellView}
        activeTheme={theme}
        avatarUrl={authUser?.avatarUrl ?? null}
        isAdmin={isAdmin}
        isStaff={isStaff}
        notificationCount={notificationCount}
        notificationsOpen={showNotifications}
        onCompose={openCompose}
        onLogin={() => { setShowNotifications(false); setDialog("login"); }}
        onOpenCommunity={() => {
          navigateToFeed();
        }}
        onOpenCommunitySection={openCommunitySection}
        onOpenProfile={() => { setShowNotifications(false); setProfileBusy(false); setDialog("profile"); }}
        onOpenAdmin={() => openStaffWorkspace("admin")}
        onOpenReview={() => openStaffWorkspace("review")}
        onSearch={setQuery}
        onToggleTheme={toggleTheme}
        onToggleNotifications={toggleNotifications}
        searchValue={query}
        siteName={siteName}
        viewer={viewer}
      />

      {siteConfig.maintenanceMode && (
        <aside className="maintenance-banner" role="status">
          <div className="maintenance-banner-inner">
            <span><strong>只读维护中</strong>社区内容仍可阅读；普通成员的发布、回复、互动、举报与上传暂时停用。</span>
            {isAdmin && <button onClick={() => openStaffWorkspace("admin")} type="button">前往管理页恢复写入</button>}
          </div>
        </aside>
      )}

      {showNotifications && authUser && (
        <NotificationPanel
          csrfToken={csrfTokenRef.current}
          onAuthenticationRequired={() => authenticationRequired("登录状态已失效，请重新登录后查看通知")}
          onClose={() => setShowNotifications(false)}
          onNavigateTopic={navigateToTopic}
          onUnreadCountChange={(count) => {
            setViewer((current) => current ? { ...current, unreadNotifications: count } : current);
          }}
        />
      )}

      {route.view === "topic" ? (
        <TopicDetail
          authUser={authUser}
          csrfToken={csrfTokenRef.current}
          hash={route.hash}
          maintenanceMode={siteConfig.maintenanceMode}
          onAuthenticationRequired={authenticationRequired}
          onBack={navigateBackFromTopic}
          onLogin={() => { setShowNotifications(false); setDialog("login"); }}
          onOpenCategory={openCategory}
          onPinChanged={refreshFeed}
          onReplyCreated={(postId) => replaceTopicHash(route.topicId, postId)}
          topicId={route.topicId}
        />
      ) : activeView === "feed" ? (
      <main className="page-frame" id="main-content">
        {showPasskeyPrompt && (
          <PasskeyPrompt
            csrfToken={csrfTokenRef.current}
            onComplete={() => {
              setShowPasskeyPrompt(false);
              setToast("Passkey 已安全添加到账号");
            }}
            onDismiss={() => setShowPasskeyPrompt(false)}
            onSessionExpired={() => {
              csrfTokenRef.current = null;
              setAuthUser(null);
              setViewer(null);
              setShowPasskeyPrompt(false);
              setDialog("login");
            }}
          />
        )}
        <section className="intro" aria-labelledby="feed-heading">
          <div className="intro-copy">
            <p className="eyebrow">{siteName} 社区刊 · 今日版</p>
            <h1 id="feed-heading">今天，社区在讨论什么？</h1>
            <p className="intro-deck">
              认真分享正在做的事，也给不同意见留出一张椅子。
            </p>
          </div>
          <div className="intro-note" aria-label="今日社区寄语">
            <span className="opening-mark" aria-hidden="true">“</span>
            <p>好的讨论不急着得出结论，先把问题照亮。</p>
            <span>— 今日编辑手记</span>
          </div>
        </section>

        {pinnedTopic && <Announcement onOpenTopic={navigateToTopic} topic={pinnedTopic} />}

        <div className="content-layout">
          <section className="feed-column" aria-label="主题信息流">
            <nav className="feed-tabs" aria-label="信息流分类">
              {TAB_OPTIONS.map((tab) => (
                <button
                  aria-current={activeTab === tab.id ? "page" : undefined}
                  className={activeTab === tab.id ? "feed-tab is-active" : "feed-tab"}
                  key={tab.id}
                  onClick={() => selectTab(tab.id)}
                  type="button"
                >
                  <span>{tab.label}</span>
                  {tab.id === "unread" && notificationCount > 0 && (
                    <span className="tab-count">{notificationCount}</span>
                  )}
                </button>
              ))}
              <button
                aria-expanded={showMobileFilters}
                className="mobile-filter-toggle"
                onClick={() => setShowMobileFilters((open) => !open)}
                type="button"
              >
                筛选 <span aria-hidden="true">⌄</span>
              </button>
            </nav>

            <FilterBar
              categories={categories}
              category={category}
              hasFilters={hasFilters}
              level={level}
              onCategoryChange={setCategory}
              onClear={clearFilters}
              onLevelChange={setLevel}
              openOnMobile={showMobileFilters}
            />

            <div className="feed-summary">
              <div>
                <strong>{activeTabMeta.label}</strong>
                <span>{activeTabMeta.hint}</span>
              </div>
              <button className="refresh-button" onClick={refreshFeed} type="button">
                <span aria-hidden="true">↻</span> 更新
              </button>
            </div>

            <FeedContent
              bookmarks={bookmarks}
              bookmarkBusy={bookmarkBusy}
              clearFilters={clearFilters}
              failure={feedFailure}
              hasFilters={hasFilters}
              onCompose={openCompose}
              onLogin={() => setDialog("login")}
              onOpenCategory={openCategory}
              onReport={openReport}
              onOpenTopic={navigateToTopic}
              status={feedStatus}
              topics={topics}
              onRetry={refreshFeed}
              onToggleBookmark={toggleBookmark}
            />

            {feedStatus === "ready" && feed?.nextCursor && (
              <button className="load-more" disabled={loadingMore} type="button" onClick={() => void loadMore()}>
                {loadingMore ? "正在载入…" : "继续阅读更早的讨论"} <span aria-hidden="true">↓</span>
              </button>
            )}
            {feedStatus === "ready" && topics.length > 0 && !feed?.nextCursor && (
              <p className="feed-end-marker">已经读到这里了 · 去参与一场讨论吧</p>
            )}
          </section>

          {feed ? (
            <Sidebar
              feed={feed}
              onCompose={openCompose}
              onOpenCategory={openCategory}
              siteName={siteName}
            />
          ) : feedStatus === "loading" ? (
            <SidebarLoading />
          ) : (
            <SidebarUnavailable onRetry={refreshFeed} />
          )}
        </div>
      </main>
      ) : activeView === "admin" ? isAdmin ? (
        <AdminWorkspace
          csrfToken={csrfTokenRef.current}
          currentUserId={authUser.id}
          initialMaintenanceMode={siteConfig.maintenanceMode}
          onAuthenticationRequired={() => authenticationRequired("登录状态已失效，请重新登录后继续管理")}
          onCategoryCreated={refreshFeed}
          onCurrentUserUpdated={(user) => {
            setAuthUser((current) =>
              current?.id === user.id
                ? { ...current, trustLevel: user.trustLevel }
                : current,
            );
            setViewer((current) =>
              current?.id === user.id
                ? { ...current, trustLevel: user.trustLevel }
                : current,
            );
            refreshFeed();
          }}
          onExit={navigateToFeed}
          onMaintenanceModeChange={(enabled) => {
            setSiteConfig((current) => ({ ...current, maintenanceMode: enabled }));
          }}
          onNotice={setToast}
          siteName={siteName}
        />
      ) : (
        <main className="review-page" id="main-content">
          <section className="review-state review-error" role="alert">
            <div aria-hidden="true">!</div>
            <h1>这个账号没有站点管理权限</h1>
            <p>邀请与维护开关仅向状态正常的管理员开放。</p>
            <button className="button button-secondary" onClick={navigateToFeed} type="button">返回社区</button>
          </section>
        </main>
      ) : isStaff ? (
        <ReviewWorkspace
          categories={categories}
          csrfToken={csrfTokenRef.current}
          onAuthenticationRequired={() => authenticationRequired("登录状态已失效，请重新登录后继续审核")}
          onExit={navigateToFeed}
          onNotice={setToast}
        />
      ) : (
        <main className="review-page" id="main-content">
          <section className="review-state review-error" role="alert">
            <div aria-hidden="true">!</div>
            <h1>这个账号没有审核权限</h1>
            <p>审核工作台仅向管理员和负责相应板块的版主开放。</p>
            <button className="button button-secondary" onClick={navigateToFeed} type="button">返回社区</button>
          </section>
        </main>
      )}

      <MobileDock
        activeView={shellView}
        activeTab={activeTab}
        avatarUrl={authUser?.avatarUrl ?? null}
        isAdmin={isAdmin}
        isStaff={isStaff}
        notificationCount={notificationCount}
        notificationsOpen={showNotifications}
        onCompose={openCompose}
        onLogin={() => { setShowNotifications(false); setDialog("login"); }}
        onOpenNotifications={toggleNotifications}
        onOpenProfile={() => { setShowNotifications(false); setProfileBusy(false); setDialog("profile"); }}
        onOpenAdmin={() => openStaffWorkspace("admin")}
        onOpenCommunitySection={openCommunitySection}
        onOpenReview={() => openStaffWorkspace("review")}
        onSelectTab={selectTab}
        viewer={viewer}
      />

      {dialog === "login" && (
        <AuthDialog
          onAuthenticated={handleAuthenticated}
          onClose={() => setDialog(null)}
          onRegistrationPending={() => {
            csrfTokenRef.current = null;
            setAuthUser(null);
            setDialog(null);
            setToast("加入申请已提交；管理员批准后即可登录");
          }}
          siteConfig={siteConfig}
          theme={theme}
        />
      )}
      {dialog === "profile" && authUser && (
        <ProfileDialog
          csrfToken={csrfTokenRef.current}
          onAuthenticationRequired={() => authenticationRequired("登录状态已失效，请重新登录后设置头像")}
          onBusyChange={setProfileBusy}
          onClose={() => setDialog(null)}
          onUpdated={(avatarUrl) => {
            setAuthUser((current) => current ? { ...current, avatarUrl } : current);
            setDialog(null);
            setToast(avatarUrl ? "头像已更新" : "头像已移除");
          }}
          user={authUser}
        />
      )}
      {dialog === "compose" && authUser && (
        <ComposeDialog
          categories={categories}
          csrfToken={csrfTokenRef.current}
          key={authUser.id}
          maxTrustLevel={authUser?.trustLevel ?? 0}
          onAuthenticationRequired={() => {
            csrfTokenRef.current = null;
            setAuthUser(null);
            setViewer(null);
            setDialog("login");
          }}
          onClose={() => setDialog(null)}
          onCompleted={() => setDialog(null)}
          onTopicCreated={(response) => {
            setToast(
              response.topic.reviewRequired
                ? "主题已提交审核，通过后会出现在信息流"
                : "主题发布成功",
            );
            setRefreshVersion((version) => version + 1);
          }}
          userId={authUser.id}
        />
      )}
      {dialog === "report" && reportTopic && (
        <ReportDialog
          csrfToken={csrfTokenRef.current}
          onAuthenticationRequired={() => {
            setReportTopic(null);
            authenticationRequired("登录状态已失效，请重新登录后再提交举报");
          }}
          onClose={() => {
            setDialog(null);
            setReportTopic(null);
          }}
          onReported={(response) => {
            setDialog(null);
            setReportTopic(null);
            setToast(
              response.created
                ? "举报已送达版务审核队列"
                : "这篇内容已经举报过；原审核事项仍在处理中",
            );
          }}
          postId={reportTopic.firstPostId}
          topicTitle={reportTopic.title}
        />
      )}

      <div aria-live="polite" aria-atomic="true" className="toast-region">
        {toast && <div className="toast">{toast}</div>}
      </div>
    </div>
  );
}

interface StartupStateProps {
  theme: Theme;
  error: string | null;
  onRetry: () => void;
  onToggleTheme: () => void;
}

function StartupState({ theme, error, onRetry, onToggleTheme }: StartupStateProps) {
  return (
    <main className="startup-screen">
      <button
        aria-label={theme === "light" ? "切换到深色模式" : "切换到浅色模式"}
        className="setup-theme-toggle"
        onClick={onToggleTheme}
        type="button"
      >
        <span aria-hidden="true">{theme === "light" ? "☾" : "☀"}</span>
      </button>
      <section className="startup-card" aria-live="polite">
        <div className="setup-brand-mark" aria-hidden="true">C</div>
        {error ? (
          <>
            <div className="startup-error-mark" aria-hidden="true">!</div>
            <h1>站点暂时没有响应</h1>
            <p>{error}</p>
            <button className="button button-primary" onClick={onRetry} type="button">
              重新检查
            </button>
          </>
        ) : (
          <>
            <div className="startup-loader" aria-hidden="true"><span /><span /><span /></div>
            <h1>正在准备社区</h1>
            <p>检查安装状态与站点配置…</p>
          </>
        )}
      </section>
    </main>
  );
}

interface InstallWizardProps {
  theme: Theme;
  onInstalled: (response: BootstrapSuccessResponse, input: BootstrapRequest) => void;
  onToggleTheme: () => void;
}

function InstallWizard({ theme, onInstalled, onToggleTheme }: InstallWizardProps) {
  const [form, setForm] = useState<BootstrapRequest>({
    siteName: "CForum",
    username: "",
    displayName: "",
    email: "",
    registrationMode: "approval",
  });
  const [secret, setSecret] = useState("");
  const [showSecret, setShowSecret] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});

  const updateField = <Key extends keyof BootstrapRequest>(
    key: Key,
    value: BootstrapRequest[Key],
  ) => {
    setForm((current) => ({ ...current, [key]: value }));
    setFieldErrors((current) => {
      if (!current[key]) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError("");
    setFieldErrors({});

    if (!/^[\p{L}\p{N}_-]{3,32}$/u.test(form.username.trim())) {
      setFieldErrors({ username: ["请输入 3–32 个汉字、字母、数字、下划线或连字符"] });
      return;
    }
    if (!secret) {
      setError("请输入部署时设置的 Bootstrap 管理密钥。");
      return;
    }

    const controller = new AbortController();
    setSubmitting(true);
    try {
      const cleanInput: BootstrapRequest = {
        siteName: form.siteName.trim(),
        username: form.username.trim(),
        displayName: form.displayName.trim(),
        email: form.email.trim().toLocaleLowerCase("en-US"),
        registrationMode: form.registrationMode,
      };
      const response = await bootstrapSite(cleanInput, secret, controller.signal);
      setSecret("");
      onInstalled(response, cleanInput);
    } catch (requestError) {
      if (requestError instanceof ApiRequestError) {
        if (requestError.fields) setFieldErrors(requestError.fields);
        if (requestError.code === "INSTALLATION_ALREADY_CLAIMED") {
          setError("站点刚刚已由另一个请求完成安装，请刷新后继续。");
        } else if (requestError.status === 404) {
          setError("管理密钥无效，或这个站点已经完成安装。");
        } else if (requestError.status === 422) {
          setError("有些信息格式不正确，请检查标出的字段。");
        } else {
          setError("安装请求没有成功，请检查 Worker 日志与 D1 状态后重试。");
        }
      } else {
        setError("网络连接中断，安装尚未提交；你可以安全地再次尝试。");
      }
    } finally {
      setSubmitting(false);
    }
  };

  const modes: ReadonlyArray<{
    value: RegistrationMode;
    title: string;
    description: string;
  }> = [
    { value: "approval", title: "审核加入", description: "邮箱验证后，由管理团队批准" },
    { value: "open", title: "开放注册", description: "邮箱验证后即可成为成员" },
    { value: "invite_only", title: "仅限邀请", description: "持有效邀请链接才能注册" },
  ];

  return (
    <main className="setup-screen">
      <button
        aria-label={theme === "light" ? "切换到深色模式" : "切换到浅色模式"}
        className="setup-theme-toggle"
        onClick={onToggleTheme}
        type="button"
      >
        <span aria-hidden="true">{theme === "light" ? "☾" : "☀"}</span>
      </button>

      <div className="setup-layout">
        <aside className="setup-intro">
          <a className="setup-brand" href="/" aria-label="CForum">
            <span className="setup-brand-mark" aria-hidden="true">C</span>
            <strong>CForum</strong>
          </a>
          <p className="eyebrow">Cloudflare 原生社区</p>
          <h1>把第一张桌子摆好，社区就可以开门了。</h1>
          <p className="setup-deck">
            这一步会建立首位管理员、站点名称与注册方式。数据只写入你的 D1，密钥不会保存在浏览器。
          </p>
          <ol className="setup-steps" aria-label="安装进度">
            <li className="is-current"><span>01</span><div><strong>创建站点</strong><small>名称与首位管理员</small></div></li>
            <li><span>02</span><div><strong>安全登录</strong><small>稍后添加 Passkey</small></div></li>
            <li><span>03</span><div><strong>邀请成员</strong><small>开始第一场讨论</small></div></li>
          </ol>
          <div className="setup-runtime-note">
            <span aria-hidden="true">云</span>
            <p><strong>完全 Serverless</strong><small>Workers · D1 · R2 · Queues · Turnstile</small></p>
          </div>
        </aside>

        <section className="setup-form-card" aria-labelledby="setup-title">
          <div className="setup-form-heading">
            <span>第 1 步，共 3 步</span>
            <h2 id="setup-title">初始化你的社区</h2>
            <p>稍后都能在管理后台调整，管理员账号除外。</p>
          </div>

          <form onSubmit={(event) => void submit(event)}>
            <fieldset className="setup-fieldset">
              <legend>站点信息</legend>
              <label className="setup-field">
                <span>站点名称</span>
                <input
                  autoFocus
                  maxLength={80}
                  onChange={(event) => updateField("siteName", event.target.value)}
                  placeholder="例如：岛屿编辑部"
                  required
                  value={form.siteName}
                />
                {fieldErrors.siteName && <small role="alert">{fieldErrors.siteName[0]}</small>}
              </label>
            </fieldset>

            <fieldset className="setup-fieldset">
              <legend>首位管理员</legend>
              <div className="setup-form-row">
                <label className="setup-field">
                  <span>管理员用户名</span>
                  <input
                    autoComplete="username"
                    maxLength={32}
                    minLength={3}
                    onChange={(event) => updateField("username", event.target.value)}
                    placeholder="linmo"
                    required
                    value={form.username}
                  />
                  {fieldErrors.username && <small role="alert">{fieldErrors.username[0]}</small>}
                </label>
                <label className="setup-field">
                  <span>显示名称</span>
                  <input
                    autoComplete="name"
                    maxLength={80}
                    onChange={(event) => updateField("displayName", event.target.value)}
                    placeholder="林默"
                    required
                    value={form.displayName}
                  />
                  {fieldErrors.displayName && <small role="alert">{fieldErrors.displayName[0]}</small>}
                </label>
              </div>
              <label className="setup-field">
                <span>管理员邮箱</span>
                <input
                  autoComplete="email"
                  maxLength={254}
                  onChange={(event) => updateField("email", event.target.value)}
                  placeholder="admin@example.com"
                  required
                  type="email"
                  value={form.email}
                />
                <small>安装完成后，这个邮箱会被标记为已验证。</small>
                {fieldErrors.email && <small role="alert">{fieldErrors.email[0]}</small>}
              </label>
            </fieldset>

            <fieldset className="setup-fieldset">
              <legend>成员如何加入</legend>
              <div className="registration-modes">
                {modes.map((mode) => (
                  <label className={form.registrationMode === mode.value ? "registration-mode is-selected" : "registration-mode"} key={mode.value}>
                    <input
                      checked={form.registrationMode === mode.value}
                      name="registration-mode"
                      onChange={() => updateField("registrationMode", mode.value)}
                      type="radio"
                      value={mode.value}
                    />
                    <span><strong>{mode.title}</strong><small>{mode.description}</small></span>
                  </label>
                ))}
              </div>
            </fieldset>

            <fieldset className="setup-fieldset secret-fieldset">
              <legend>确认部署权限</legend>
              <label className="setup-field">
                <span>Bootstrap 管理密钥</span>
                <div className="secret-input">
                  <input
                    autoComplete="off"
                    onChange={(event) => setSecret(event.target.value)}
                    placeholder="粘贴 BOOTSTRAP_ADMIN_SECRET"
                    required
                    spellCheck={false}
                    type={showSecret ? "text" : "password"}
                    value={secret}
                  />
                  <button
                    aria-label={showSecret ? "隐藏密钥" : "显示密钥"}
                    onClick={() => setShowSecret((visible) => !visible)}
                    type="button"
                  >
                    {showSecret ? "隐藏" : "显示"}
                  </button>
                </div>
                <small>只随这次请求发送，安装成功后立即从页面内存清除。</small>
              </label>
            </fieldset>

            {error && <div className="setup-error" role="alert"><span aria-hidden="true">!</span>{error}</div>}

            <button className="button button-primary setup-submit" disabled={submitting} type="submit">
              {submitting ? "正在安全地创建…" : "创建站点并进入社区"}
              {!submitting && <span aria-hidden="true">→</span>}
            </button>
            <p className="setup-security"><span aria-hidden="true">盾</span> 管理会话使用 Secure、HttpOnly Cookie 建立</p>
          </form>
        </section>
      </div>
    </main>
  );
}

interface TopBarProps {
  activeView: ActiveView;
  activeTheme: Theme;
  avatarUrl: string | null;
  isAdmin: boolean;
  isStaff: boolean;
  notificationCount: number;
  notificationsOpen: boolean;
  searchValue: string;
  siteName: string;
  viewer: FeedResponse["viewer"];
  onCompose: () => void;
  onLogin: () => void;
  onOpenAdmin: () => void;
  onOpenCommunity: () => void;
  onOpenCommunitySection: (section: CommunitySection) => void;
  onOpenProfile: () => void;
  onOpenReview: () => void;
  onSearch: (value: string) => void;
  onToggleTheme: () => void;
  onToggleNotifications: () => void;
}

function TopBar({
  activeView,
  activeTheme,
  avatarUrl,
  isAdmin,
  isStaff,
  notificationCount,
  notificationsOpen,
  searchValue,
  siteName,
  viewer,
  onCompose,
  onLogin,
  onOpenAdmin,
  onOpenCommunity,
  onOpenCommunitySection,
  onOpenProfile,
  onOpenReview,
  onSearch,
  onToggleTheme,
  onToggleNotifications,
}: TopBarProps) {
  return (
    <header className="topbar">
      <div className="topbar-inner">
        <a
          className="brand"
          href="/"
          aria-label={`${siteName} 首页`}
          onClick={(event) => {
            if (!isPlainLeftClick(event)) return;
            event.preventDefault();
            onOpenCommunity();
          }}
        >
          <span className="brand-mark" aria-hidden="true">{[...siteName][0] ?? "C"}</span>
          <span className="brand-word">{siteName}</span>
          <span className="brand-tagline">认真交流的地方</span>
        </a>

        <nav className="desktop-nav" aria-label="主导航">
          <button
            aria-current={activeView === "feed" ? "page" : undefined}
            className={activeView === "feed" ? "is-current" : ""}
            onClick={onOpenCommunity}
            type="button"
          >社区</button>
          <a
            href="/#categories"
            onClick={(event) => {
              if (!isPlainLeftClick(event)) return;
              event.preventDefault();
              onOpenCommunitySection("categories");
            }}
          >板块</a>
          <a
            href="/#community-pulse"
            onClick={(event) => {
              if (!isPlainLeftClick(event)) return;
              event.preventDefault();
              onOpenCommunitySection("community-pulse");
            }}
          >成员</a>
          <a
            href="/#community-guide"
            onClick={(event) => {
              if (!isPlainLeftClick(event)) return;
              event.preventDefault();
              onOpenCommunitySection("community-guide");
            }}
          >公约</a>
          {isStaff && (
            <button
              aria-current={activeView === "review" ? "page" : undefined}
              className={activeView === "review" ? "is-current staff-nav" : "staff-nav"}
              onClick={onOpenReview}
              type="button"
            >审核</button>
          )}
          {isAdmin && (
            <button
              aria-current={activeView === "admin" ? "page" : undefined}
              className={activeView === "admin" ? "is-current staff-nav" : "staff-nav"}
              onClick={onOpenAdmin}
              type="button"
            >管理</button>
          )}
        </nav>

        <div className="topbar-actions">
          <label className="header-search">
            <span className="visually-hidden">搜索社区</span>
            <span className="search-glyph" aria-hidden="true">⌕</span>
            <input
              onChange={(event) => onSearch(event.target.value)}
              placeholder="搜索讨论…"
              type="search"
              value={searchValue}
            />
            <kbd>⌘ K</kbd>
          </label>
          <button
            aria-label={activeTheme === "light" ? "切换到深色模式" : "切换到浅色模式"}
            className="icon-button"
            onClick={onToggleTheme}
            type="button"
          >
            <span aria-hidden="true">{activeTheme === "light" ? "☾" : "☀"}</span>
          </button>
          <button
            aria-controls="notification-panel"
            aria-expanded={notificationsOpen}
            aria-haspopup="dialog"
            aria-label={`${notificationCount} 条未读通知`}
            className="notification-button"
            onClick={onToggleNotifications}
            type="button"
          >
            <span aria-hidden="true">铃</span>
            {notificationCount > 0 && <span className="notification-dot">{notificationCount}</span>}
          </button>
          {viewer ? (
            <button aria-label="打开个人设置" className="viewer-action viewer-summary" onClick={onOpenProfile} type="button">
              <span aria-hidden="true">{avatarUrl ? <img alt="" src={avatarUrl} /> : ([...viewer.displayName][0] ?? "我")}</span>
              <strong>{viewer.displayName}</strong>
              <small>Lv{viewer.trustLevel}</small>
            </button>
          ) : (
            <button className="button button-quiet login-action" onClick={onLogin} type="button">
              登录
            </button>
          )}
          <button className="button button-primary compose-action" onClick={onCompose} type="button">
            <span aria-hidden="true">＋</span> 发起讨论
          </button>
        </div>
      </div>
    </header>
  );
}

function Announcement({
  topic,
  onOpenTopic,
}: {
  topic: FeedTopic;
  onOpenTopic: (topicId: string) => void;
}) {
  return (
    <aside className="announcement" aria-label="站务置顶">
      <div className="announcement-icon" aria-hidden="true">!</div>
      <div className="announcement-copy">
        <span>站务置顶</span>
        <a
          href={`/t/${encodeURIComponent(topic.id)}`}
          onClick={(event) => {
            if (!isPlainLeftClick(event)) return;
            event.preventDefault();
            onOpenTopic(topic.id);
          }}
        >{topic.title}</a>
      </div>
      <span className="announcement-meta">
        {formatRelativeTime(topic.bumpedAt)} · {topic.replyCount} 条回复
      </span>
      <span className="announcement-arrow" aria-hidden="true">→</span>
    </aside>
  );
}

interface FilterBarProps {
  categories: CategorySummary[];
  category: string;
  level: LevelFilter;
  hasFilters: boolean;
  openOnMobile: boolean;
  onCategoryChange: (value: string) => void;
  onLevelChange: (value: LevelFilter) => void;
  onClear: () => void;
}

function FilterBar({
  categories,
  category,
  level,
  hasFilters,
  openOnMobile,
  onCategoryChange,
  onLevelChange,
  onClear,
}: FilterBarProps) {
  return (
    <div className={openOnMobile ? "filter-bar is-mobile-open" : "filter-bar"}>
      <label>
        <span>板块</span>
        <select value={category} onChange={(event) => onCategoryChange(event.target.value)}>
          <option value="all">全部板块</option>
          {categories.map((item) => (
            <option key={item.id} value={item.slug}>{item.name}</option>
          ))}
        </select>
      </label>
      <label>
        <span>可见等级</span>
        <select
          value={level}
          onChange={(event) => onLevelChange(event.target.value as LevelFilter)}
        >
          {LEVEL_OPTIONS.map((item) => (
            <option key={item.value} value={item.value}>{item.label}</option>
          ))}
        </select>
      </label>
      <button
        className="clear-filters"
        disabled={!hasFilters}
        onClick={onClear}
        type="button"
      >
        清除筛选
      </button>
    </div>
  );
}

interface FeedContentProps {
  topics: FeedTopic[];
  bookmarks: Set<string>;
  bookmarkBusy: Set<string>;
  status: FeedStatus;
  failure: FeedFailure | null;
  hasFilters: boolean;
  clearFilters: () => void;
  onCompose: () => void;
  onLogin: () => void;
  onOpenCategory: (categorySlug: string) => void;
  onOpenTopic: (topicId: string) => void;
  onRetry: () => void;
  onReport: (topic: FeedTopic) => void;
  onToggleBookmark: (topic: FeedTopic) => void;
}

function FeedContent({
  topics,
  bookmarks,
  bookmarkBusy,
  status,
  failure,
  hasFilters,
  clearFilters,
  onCompose,
  onLogin,
  onOpenCategory,
  onOpenTopic,
  onRetry,
  onReport,
  onToggleBookmark,
}: FeedContentProps) {
  if (status === "loading") return <FeedLoading />;
  if (status === "error") {
    return <FeedError failure={failure} onLogin={onLogin} onRetry={onRetry} />;
  }
  if (topics.length === 0) {
    return (
      <FeedEmpty
        hasFilters={hasFilters}
        onAction={hasFilters ? clearFilters : onCompose}
      />
    );
  }

  return (
    <div className="topic-list">
      {topics.map((topic) => (
        <TopicCard
          bookmarked={bookmarks.has(topic.id)}
          bookmarkBusy={bookmarkBusy.has(topic.id)}
          key={topic.id}
          onToggleBookmark={() => onToggleBookmark(topic)}
          onReport={() => onReport(topic)}
          onOpenCategory={() => onOpenCategory(topic.category.slug)}
          onOpenTopic={() => onOpenTopic(topic.id)}
          topic={topic}
        />
      ))}
    </div>
  );
}

interface TopicCardProps {
  topic: FeedTopic;
  bookmarked: boolean;
  bookmarkBusy: boolean;
  onReport: () => void;
  onOpenCategory: () => void;
  onOpenTopic: () => void;
  onToggleBookmark: () => void;
}

function TopicCard({
  topic,
  bookmarked,
  bookmarkBusy,
  onReport,
  onOpenCategory,
  onOpenTopic,
  onToggleBookmark,
}: TopicCardProps) {
  return (
    <article
      className={topic.pinned ? "topic-card is-pinned" : "topic-card"}
      onClick={(event) => {
        if ((event.target as HTMLElement).closest("a, button, input, select, textarea")) return;
        if (window.getSelection()?.toString()) return;
        onOpenTopic();
      }}
    >
      <div className="topic-main">
        <div className="topic-kicker">
          <button
            className="category-label"
            onClick={onOpenCategory}
            style={categoryStyle(topic.category.accent)}
            type="button"
          >
            <span aria-hidden="true" />
            {topic.category.name}
          </button>
          {topic.pinned && <span className="status-chip pinned-chip">置顶</span>}
          {topic.signals.newToViewer && <span className="status-chip new-chip">新</span>}
          <VisibilityBadge visibility={topic.visibility} />
          {topic.locked && <span className="status-chip lock-chip">已锁定</span>}
        </div>

        <h2>
          <a
            href={`/t/${encodeURIComponent(topic.id)}`}
            onClick={(event) => {
              if (!isPlainLeftClick(event)) return;
              event.preventDefault();
              onOpenTopic();
            }}
          >{topic.title}</a>
        </h2>
        <p className="topic-excerpt">{topic.excerpt}</p>

        <div className="topic-tags" aria-label="主题标签">
          {topic.tags.map((tag) => (
            <span key={tag}>#{tag}</span>
          ))}
        </div>

        <footer className="topic-footer">
          <div className="author" title="个人页面尚未开放">
            <span className={`avatar avatar-${topic.author.avatarTone}`} aria-hidden="true">
              {topic.author.avatarUrl ? <img alt="" src={topic.author.avatarUrl} /> : topic.author.initials}
            </span>
            <span>
              <strong>{topic.author.displayName}</strong>
              <small>Lv{topic.author.trustLevel}</small>
            </span>
          </div>
          <span className="topic-time">
            <time dateTime={topic.bumpedAt} title={new Date(topic.bumpedAt).toLocaleString("zh-CN")}>
              {formatRelativeTime(topic.bumpedAt)}
            </time>
            <span>由 {topic.lastPosterName} 更新</span>
          </span>
          <div className="topic-stats" aria-label="主题互动数据">
            <span title={`${topic.participantCount} 人参与`}><i aria-hidden="true">人</i>{topic.participantCount}</span>
            <span title={`${topic.likeCount} 个赞`}><i aria-hidden="true">心</i>{formatCount(topic.likeCount)}</span>
            <span className={topic.unreadPosts > 0 ? "reply-stat has-unread" : "reply-stat"} title={`${topic.replyCount} 条回复`}>
              <i aria-hidden="true">回</i>{topic.replyCount}
              {topic.unreadPosts > 0 && <b>+{topic.unreadPosts}</b>}
            </span>
            <button
              aria-label={`举报“${topic.title}”的首帖`}
              className="report-button"
              onClick={onReport}
              title="举报首帖"
              type="button"
            >
              <span aria-hidden="true">旗</span><small>举报</small>
            </button>
            <button
              aria-busy={bookmarkBusy}
              aria-label={bookmarkBusy ? "正在更新收藏" : bookmarked ? "取消收藏" : "收藏主题"}
              aria-pressed={bookmarked}
              className={bookmarked ? "bookmark-button is-saved" : "bookmark-button"}
              disabled={bookmarkBusy}
              onClick={onToggleBookmark}
              type="button"
            >
              <span aria-hidden="true">{bookmarkBusy ? "…" : bookmarked ? "◆" : "◇"}</span>
            </button>
          </div>
        </footer>
      </div>

      {topic.coverTone && <TopicCover tone={topic.coverTone} />}
    </article>
  );
}

function VisibilityBadge({ visibility }: { visibility: TopicVisibility }) {
  if (visibility.kind === "public") return null;
  if (visibility.kind === "group") {
    return (
      <span className="status-chip private-chip" title={`仅 ${visibility.label} 组成员可见`}>
        <span aria-hidden="true">钥</span> {visibility.label}私密
      </span>
    );
  }
  return (
    <span className="status-chip level-chip" title={`仅信任等级 ${visibility.minLevel} 及以上可见`}>
      Lv{visibility.minLevel}+ 可见
    </span>
  );
}

function TopicCover({ tone }: { tone: NonNullable<FeedTopic["coverTone"]> }) {
  const content = {
    blueprint: ["QUERY PLAN", "23 ms", "INDEX → CURSOR"],
    books: ["READ · NOTE", "一年", "RETURN TO TEXT"],
    garden: ["4 m²", "GROW SLOW", "SUN · WATER"],
  }[tone];
  return (
    <div className={`topic-cover cover-${tone}`} aria-hidden="true">
      <small>{content[0]}</small>
      <strong>{content[1]}</strong>
      <span>{content[2]}</span>
    </div>
  );
}

function FeedLoading() {
  return (
    <div className="state-stack" aria-live="polite" aria-busy="true">
      <p className="visually-hidden">正在载入讨论</p>
      {[0, 1, 2].map((item) => (
        <div className="skeleton-card" key={item}>
          <div className="skeleton-line skeleton-short" />
          <div className="skeleton-line skeleton-title" />
          <div className="skeleton-line" />
          <div className="skeleton-line skeleton-medium" />
          <div className="skeleton-meta" />
        </div>
      ))}
    </div>
  );
}

function FeedEmpty({
  hasFilters,
  onAction,
}: {
  hasFilters: boolean;
  onAction: () => void;
}) {
  return (
    <div className="feed-state empty-state">
      <div className="state-symbol" aria-hidden="true">○</div>
      <h2>{hasFilters ? "这里暂时没有匹配的讨论" : "第一场讨论，等你开口"}</h2>
      <p>
        {hasFilters
          ? "换一个板块或等级范围，也许会遇见新的话题。"
          : "社区已经准备好了。分享一个正在思考的问题，让下一位成员有地方回应。"}
      </p>
      <button className={hasFilters ? "button button-secondary" : "button button-primary"} onClick={onAction} type="button">
        {hasFilters ? "清除全部筛选" : "发起第一场讨论"}
      </button>
    </div>
  );
}

function FeedError({
  failure,
  onLogin,
  onRetry,
}: {
  failure: FeedFailure | null;
  onLogin: () => void;
  onRetry: () => void;
}) {
  const needsLogin = failure?.authenticationRequired ?? false;
  return (
    <div className="feed-state error-state" role="alert">
      <div className="state-symbol" aria-hidden="true">!</div>
      <h2>{needsLogin ? "这部分内容属于你的账号" : "讨论暂时没有送达"}</h2>
      <p>{failure?.message ?? "请稍后重试。你的筛选条件仍会保留。"}</p>
      <button
        className={needsLogin ? "button button-primary" : "button button-secondary"}
        onClick={needsLogin ? onLogin : onRetry}
        type="button"
      >
        {needsLogin ? "前往登录" : "重新载入"}
      </button>
    </div>
  );
}

function Sidebar({
  feed,
  onCompose,
  onOpenCategory,
  siteName,
}: {
  feed: FeedResponse;
  onCompose: () => void;
  onOpenCategory: (categorySlug: string) => void;
  siteName: string;
}) {
  return (
    <aside className="sidebar" aria-label="社区概览">
      <section className="sidebar-panel categories-panel" id="categories" tabIndex={-1}>
        <div className="panel-heading">
          <h2>浏览板块</h2>
          <button onClick={() => onOpenCategory("all")} type="button">全部 <span aria-hidden="true">→</span></button>
        </div>
        <ul className="category-list">
          {feed.categories.map((category) => (
            <li key={category.id}>
              <button onClick={() => onOpenCategory(category.slug)} style={categoryStyle(category.accent)} type="button">
                <span className="category-marker" aria-hidden="true" />
                <span>
                  <strong>{category.name}</strong>
                  <small>{category.description}</small>
                </span>
                <span className="category-count">
                  {category.unreadCount > 0 && <b>{category.unreadCount}</b>}
                  {formatCount(category.topicCount)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section className="sidebar-panel pulse-panel" id="community-pulse" tabIndex={-1}>
        <div className="panel-heading">
          <h2>此刻的社区</h2>
          <span className="live-label"><i /> LIVE</span>
        </div>
        <div className="pulse-grid">
          <div><strong>{feed.pulse.membersOnline}</strong><span>人在线</span></div>
          <div><strong>{feed.pulse.newTopicsToday}</strong><span>今日新主题</span></div>
          <div><strong>{feed.pulse.repliesToday}</strong><span>今日回复</span></div>
          <div><strong>{formatCount(feed.pulse.activeMembersThisWeek)}</strong><span>本周活跃</span></div>
        </div>
        <div className="pulse-note">
          <span aria-hidden="true">{feed.pulse.membersOnline > 0 ? "●" : "○"}</span>
          <p>
            {feed.pulse.membersOnline > 0
              ? `${feed.pulse.membersOnline} 位成员正在阅读或参与讨论`
              : "社区刚刚开门，来写下今天的第一条讨论吧"}
          </p>
        </div>
      </section>

      <section className="sidebar-panel guide-panel" id="community-guide" tabIndex={-1}>
        <p className="eyebrow">第一次来？</p>
        <h2>从一段真诚的自我介绍开始</h2>
        <p>说说你正在学习、制作或反复思考的事。这里不需要完美答案。</p>
        <button className="text-action" onClick={onCompose} type="button">
          写下第一篇主题 <span aria-hidden="true">→</span>
        </button>
      </section>

      <footer className="sidebar-footer">
        <a href="/about">关于</a>
        <a href="/#community-guide">社区公约</a>
        <a href="/privacy">隐私</a>
        <a href="/contact">联系</a>
        <span>© 2026 {siteName}</span>
      </footer>
    </aside>
  );
}

function SidebarLoading() {
  return (
    <aside className="sidebar sidebar-loading" aria-label="正在载入社区概览" aria-busy="true">
      <section className="sidebar-panel">
        <div className="skeleton-line skeleton-medium" />
        <div className="skeleton-line" />
        <div className="skeleton-line" />
        <div className="skeleton-line skeleton-medium" />
      </section>
      <section className="sidebar-panel">
        <div className="skeleton-line skeleton-short" />
        <div className="sidebar-skeleton-grid"><span /><span /><span /><span /></div>
      </section>
    </aside>
  );
}

function SidebarUnavailable({ onRetry }: { onRetry: () => void }) {
  return (
    <aside className="sidebar" aria-label="社区概览暂不可用">
      <section className="sidebar-panel sidebar-unavailable">
        <span aria-hidden="true">!</span>
        <strong>概览暂不可用</strong>
        <p>恢复连接后，这里会显示板块和社区状态。</p>
        <button className="text-action" onClick={onRetry} type="button">重新载入</button>
      </section>
    </aside>
  );
}

interface MobileDockProps {
  activeView: ActiveView;
  activeTab: FeedTab;
  avatarUrl: string | null;
  isAdmin: boolean;
  isStaff: boolean;
  notificationCount: number;
  notificationsOpen: boolean;
  onSelectTab: (tab: FeedTab) => void;
  onCompose: () => void;
  onLogin: () => void;
  onOpenAdmin: () => void;
  onOpenCommunitySection: (section: CommunitySection) => void;
  onOpenNotifications: () => void;
  onOpenProfile: () => void;
  onOpenReview: () => void;
  viewer: FeedResponse["viewer"];
}

function MobileDock({
  activeView,
  activeTab,
  avatarUrl,
  isAdmin,
  isStaff,
  notificationCount,
  notificationsOpen,
  onSelectTab,
  onCompose,
  onLogin,
  onOpenAdmin,
  onOpenCommunitySection,
  onOpenNotifications,
  onOpenProfile,
  onOpenReview,
  viewer,
}: MobileDockProps) {
  const [communityNavOpen, setCommunityNavOpen] = useState(false);
  const communityNavButtonRef = useRef<HTMLButtonElement>(null);
  const communityNavMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!communityNavOpen) return;

    const closeOnOutsidePress = (event: PointerEvent) => {
      if (!(event.target instanceof Node)) return;
      if (
        communityNavButtonRef.current?.contains(event.target) ||
        communityNavMenuRef.current?.contains(event.target)
      ) {
        return;
      }
      setCommunityNavOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setCommunityNavOpen(false);
      communityNavButtonRef.current?.focus();
    };

    window.addEventListener("pointerdown", closeOnOutsidePress);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("pointerdown", closeOnOutsidePress);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [communityNavOpen]);

  const runAndClose = (action: () => void) => {
    setCommunityNavOpen(false);
    action();
  };

  const openSection = (section: CommunitySection) => {
    setCommunityNavOpen(false);
    onOpenCommunitySection(section);
  };

  return (
    <>
      <nav className={isAdmin ? "mobile-dock has-staff has-admin" : isStaff ? "mobile-dock has-staff" : "mobile-dock"} aria-label="移动端主导航">
        <button className={activeView === "feed" && activeTab === "all" ? "is-active" : ""} onClick={() => runAndClose(() => onSelectTab("all"))} type="button">
          <span aria-hidden="true">⌂</span><small>首页</small>
        </button>
        <button
          aria-controls="mobile-community-menu"
          aria-expanded={communityNavOpen}
          aria-haspopup="menu"
          aria-label="打开社区导航"
          className={communityNavOpen ? "is-active" : ""}
          onClick={() => setCommunityNavOpen((open) => !open)}
          ref={communityNavButtonRef}
          type="button"
        >
          <span aria-hidden="true">览</span><small>社区</small>
        </button>
        <button className="dock-compose" onClick={() => runAndClose(onCompose)} type="button">
          <span aria-hidden="true">＋</span><small>发布</small>
        </button>
        {isStaff && (
          <button className={activeView === "review" ? "is-active" : ""} onClick={() => runAndClose(onOpenReview)} type="button">
            <span aria-hidden="true">审</span><small>审核</small>
          </button>
        )}
        {isAdmin && (
          <button className={activeView === "admin" ? "is-active" : ""} onClick={() => runAndClose(onOpenAdmin)} type="button">
            <span aria-hidden="true">管</span><small>管理</small>
          </button>
        )}
        <button
          aria-controls="notification-panel"
          aria-expanded={notificationsOpen}
          aria-haspopup="dialog"
          aria-label={`${notificationCount} 条未读通知`}
          className={notificationsOpen ? "is-active" : ""}
          onClick={() => runAndClose(onOpenNotifications)}
          type="button"
        >
          <span className="dock-notification" aria-hidden="true">铃{notificationCount > 0 && <b>{notificationCount}</b>}</span><small>通知</small>
        </button>
        {viewer ? (
          <button className="dock-viewer" onClick={() => runAndClose(onOpenProfile)} type="button">
            <span aria-hidden="true">{avatarUrl ? <img alt="" src={avatarUrl} /> : ([...viewer.displayName][0] ?? "我")}</span><small>我的</small>
          </button>
        ) : (
          <button onClick={() => runAndClose(onLogin)} type="button">
            <span aria-hidden="true">我</span><small>登录</small>
          </button>
        )}
      </nav>

      {communityNavOpen && (
        <div
          aria-label="社区导航"
          className="mobile-community-menu"
          id="mobile-community-menu"
          ref={communityNavMenuRef}
          role="menu"
        >
          <button onClick={() => openSection("categories")} role="menuitem" type="button">
            <span aria-hidden="true">板</span><strong>板块</strong><small>浏览讨论分区</small>
          </button>
          <button onClick={() => openSection("community-pulse")} role="menuitem" type="button">
            <span aria-hidden="true">人</span><strong>成员</strong><small>查看社区此刻</small>
          </button>
          <button onClick={() => openSection("community-guide")} role="menuitem" type="button">
            <span aria-hidden="true">约</span><strong>公约</strong><small>阅读交流原则</small>
          </button>
        </div>
      )}
    </>
  );
}
