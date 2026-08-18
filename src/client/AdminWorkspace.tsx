import { useEffect, useRef, useState, type CSSProperties, type FormEvent } from "react";
import {
  createAdminCategory,
  getAdminCategories,
  getAdminSettings,
  getAdminUsers,
  updateAdminSettings,
  updateAdminUser,
  type AdminCategory,
  type AdminSettings,
  type AdminUser,
  type AdminUserRole,
  type CreateAdminCategoryInput,
} from "./admin";
import { ApiRequestError } from "./api";
import {
  createSingleUseInvite,
  getAdminInvites,
  revokeAdminInvite,
  type AdminInvite,
} from "./invites";

interface AdminWorkspaceProps {
  csrfToken: string | null;
  currentUserId: string;
  initialMaintenanceMode: boolean;
  onAuthenticationRequired: () => void;
  onCategoryCreated: () => void;
  onCurrentUserUpdated: (user: AdminUser) => void;
  onExit: () => void;
  onMaintenanceModeChange: (enabled: boolean) => void;
  onNotice: (message: string) => void;
  siteName: string;
}

type WorkspaceStatus = "loading" | "ready" | "error";

const TRUST_LEVELS = [0, 1, 2, 3, 4] as const;

const EMPTY_CATEGORY: CreateAdminCategoryInput = {
  slug: "",
  name: "",
  description: "",
  color: "#397f73",
  aclMode: "open",
  minViewLevel: 0,
  minCreateLevel: 0,
  minReplyLevel: 0,
  allowedTopicMinLevelMax: 4,
  allowImages: true,
};

function trustLevelValue(value: string): (typeof TRUST_LEVELS)[number] {
  const parsed = Number(value);
  return TRUST_LEVELS.includes(parsed as (typeof TRUST_LEVELS)[number])
    ? (parsed as (typeof TRUST_LEVELS)[number])
    : 0;
}

function atLeastTrustLevel(
  value: (typeof TRUST_LEVELS)[number],
  minimum: (typeof TRUST_LEVELS)[number],
): (typeof TRUST_LEVELS)[number] {
  return Math.max(value, minimum) as (typeof TRUST_LEVELS)[number];
}

function formatDate(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "时间未知";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function inviteStatusLabel(invite: AdminInvite): string {
  if (invite.status === "active") return "可使用";
  if (invite.status === "exhausted") return "已使用";
  if (invite.status === "expired") return "已过期";
  return "已撤销";
}

function roleLabel(role: AdminUserRole): string {
  if (role === "admin") return "管理员";
  if (role === "moderator") return "版主";
  return "成员";
}

function userStatusLabel(status: AdminUser["status"]): string {
  if (status === "active") return "正常";
  if (status === "pending") return "待审核";
  if (status === "silenced") return "已禁言";
  if (status === "suspended") return "已停权";
  return "已删除";
}

function adminFailureMessage(error: unknown): string {
  if (!(error instanceof ApiRequestError)) return "管理服务暂时不可用，请检查网络后重试。";
  if (error.status === 401) return "登录状态已经失效。";
  if (error.status === 403) return "当前账号没有管理员权限。";
  if (error.code === "INVALID_CSRF_TOKEN") return "会话安全令牌已失效，请刷新页面后重试。";
  if (error.code === "INVITE_SERVICE_UNAVAILABLE") return "邀请服务尚未配置安全密钥，请先检查 Worker secrets。";
  if (error.code === "LAST_ACTIVE_ADMIN_REQUIRED") return "至少要保留一名状态正常的管理员。请先任命另一位管理员。";
  if (error.code === "USER_CHANGED") return "这位成员的资料刚刚发生变化，请刷新后再操作。";
  if (error.code === "CATEGORY_SLUG_TAKEN") return "这个板块标识已经被使用，请换一个。";
  if (error.code === "CATEGORY_CREATE_FAILED") return "板块已经写入，但读取结果失败，请重新载入管理页确认。";
  if (error.status === 404) return "目标已经不存在或被移除，请重新载入管理页。";
  return "操作没有完成，请稍后重试。";
}

function inviteRegistrationUrl(token: string): string {
  const url = new URL("/", window.location.origin);
  url.searchParams.set("invite", token);
  return url.toString();
}

export default function AdminWorkspace({
  csrfToken,
  currentUserId,
  initialMaintenanceMode,
  onAuthenticationRequired,
  onCategoryCreated,
  onCurrentUserUpdated,
  onExit,
  onMaintenanceModeChange,
  onNotice,
  siteName,
}: AdminWorkspaceProps) {
  const [status, setStatus] = useState<WorkspaceStatus>("loading");
  const [settings, setSettings] = useState<AdminSettings>({
    maintenanceMode: initialMaintenanceMode,
  });
  const [invites, setInvites] = useState<AdminInvite[]>([]);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [categories, setCategories] = useState<AdminCategory[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [userNextCursor, setUserNextCursor] = useState<string | null>(null);
  const [userQuery, setUserQuery] = useState("");
  const [appliedUserQuery, setAppliedUserQuery] = useState("");
  const [categoryForm, setCategoryForm] = useState<CreateAdminCategoryInput>(EMPTY_CATEGORY);
  const [error, setError] = useState("");
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [savingMaintenance, setSavingMaintenance] = useState(false);
  const [creatingInvite, setCreatingInvite] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadingMoreUsers, setLoadingMoreUsers] = useState(false);
  const [searchingUsers, setSearchingUsers] = useState(false);
  const [savingUserId, setSavingUserId] = useState<string | null>(null);
  const [creatingCategory, setCreatingCategory] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [confirmRevokeId, setConfirmRevokeId] = useState<string | null>(null);
  const [createdToken, setCreatedToken] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const authRequiredRef = useRef(onAuthenticationRequired);
  const maintenanceChangeRef = useRef(onMaintenanceModeChange);

  useEffect(() => {
    authRequiredRef.current = onAuthenticationRequired;
  }, [onAuthenticationRequired]);

  useEffect(() => {
    maintenanceChangeRef.current = onMaintenanceModeChange;
  }, [onMaintenanceModeChange]);

  useEffect(() => {
    const controller = new AbortController();
    setStatus("loading");
    setError("");
    setCreatedToken(null);
    setCopyState("idle");

    void Promise.all([
      getAdminSettings(controller.signal),
      getAdminInvites(undefined, controller.signal),
      getAdminUsers({}, controller.signal),
      getAdminCategories(controller.signal),
    ])
      .then(([settingsResponse, inviteResponse, userResponse, categoryResponse]) => {
        setSettings(settingsResponse.settings);
        if (typeof settingsResponse.settings.maintenanceMode === "boolean") {
          maintenanceChangeRef.current(settingsResponse.settings.maintenanceMode);
        }
        setInvites(inviteResponse.items);
        setNextCursor(inviteResponse.nextCursor);
        setUsers(userResponse.items);
        setUserNextCursor(userResponse.nextCursor);
        setCategories(categoryResponse.items);
        setUserQuery("");
        setAppliedUserQuery("");
        setStatus("ready");
      })
      .catch((requestError: unknown) => {
        if (requestError instanceof DOMException && requestError.name === "AbortError") return;
        if (requestError instanceof ApiRequestError && requestError.status === 401) {
          authRequiredRef.current();
          return;
        }
        setError(adminFailureMessage(requestError));
        setStatus("error");
      });

    return () => controller.abort();
  }, [refreshVersion]);

  const maintenanceMode = settings.maintenanceMode ?? initialMaintenanceMode;

  const toggleMaintenance = async () => {
    if (!csrfToken || savingMaintenance) {
      if (!csrfToken) setError("会话安全令牌不可用，请刷新页面后重试。");
      return;
    }
    const nextValue = !maintenanceMode;
    setSavingMaintenance(true);
    setError("");
    try {
      await updateAdminSettings({ maintenanceMode: nextValue }, csrfToken);
      setSettings((current) => ({ ...current, maintenanceMode: nextValue }));
      onMaintenanceModeChange(nextValue);
      onNotice(nextValue ? "维护模式已开启：普通成员现在只能阅读" : "维护模式已关闭：社区写入已恢复");
    } catch (requestError) {
      if (requestError instanceof ApiRequestError && requestError.status === 401) {
        authRequiredRef.current();
      } else {
        setError(adminFailureMessage(requestError));
      }
    } finally {
      setSavingMaintenance(false);
    }
  };

  const createInvite = async () => {
    if (!csrfToken || creatingInvite) {
      if (!csrfToken) setError("会话安全令牌不可用，请刷新页面后重试。");
      return;
    }
    setCreatingInvite(true);
    setCreatedToken(null);
    setCopyState("idle");
    setError("");
    try {
      const response = await createSingleUseInvite(csrfToken);
      setInvites((current) => [response.invite, ...current.filter((item) => item.id !== response.invite.id)]);
      setCreatedToken(response.token);
      onNotice("一次性邀请已创建；请现在复制，离开后无法再次查看");
    } catch (requestError) {
      if (requestError instanceof ApiRequestError && requestError.status === 401) {
        authRequiredRef.current();
      } else {
        setError(adminFailureMessage(requestError));
      }
    } finally {
      setCreatingInvite(false);
    }
  };

  const copyInvite = async () => {
    if (!createdToken) return;
    try {
      await navigator.clipboard.writeText(inviteRegistrationUrl(createdToken));
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  };

  const loadMore = async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    setError("");
    try {
      const response = await getAdminInvites(nextCursor);
      setInvites((current) => {
        const seen = new Set(current.map((item) => item.id));
        return [...current, ...response.items.filter((item) => !seen.has(item.id))];
      });
      setNextCursor(response.nextCursor);
    } catch (requestError) {
      if (requestError instanceof ApiRequestError && requestError.status === 401) {
        authRequiredRef.current();
      } else {
        setError(adminFailureMessage(requestError));
      }
    } finally {
      setLoadingMore(false);
    }
  };

  const searchUsers = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (searchingUsers) return;
    const nextQuery = userQuery.trim();
    setSearchingUsers(true);
    setError("");
    try {
      const response = await getAdminUsers({ query: nextQuery || undefined });
      setUsers(response.items);
      setUserNextCursor(response.nextCursor);
      setAppliedUserQuery(nextQuery);
    } catch (requestError) {
      if (requestError instanceof ApiRequestError && requestError.status === 401) {
        authRequiredRef.current();
      } else {
        setError(adminFailureMessage(requestError));
      }
    } finally {
      setSearchingUsers(false);
    }
  };

  const loadMoreUsers = async () => {
    if (!userNextCursor || loadingMoreUsers) return;
    setLoadingMoreUsers(true);
    setError("");
    try {
      const response = await getAdminUsers({
        query: appliedUserQuery || undefined,
        cursor: userNextCursor,
      });
      setUsers((current) => {
        const seen = new Set(current.map((item) => item.id));
        return [...current, ...response.items.filter((item) => !seen.has(item.id))];
      });
      setUserNextCursor(response.nextCursor);
    } catch (requestError) {
      if (requestError instanceof ApiRequestError && requestError.status === 401) {
        authRequiredRef.current();
      } else {
        setError(adminFailureMessage(requestError));
      }
    } finally {
      setLoadingMoreUsers(false);
    }
  };

  const changeUser = async (
    user: AdminUser,
    patch: Partial<Pick<AdminUser, "trustLevel" | "levelLocked" | "role">>,
  ) => {
    if (!csrfToken || savingUserId) {
      if (!csrfToken) setError("会话安全令牌不可用，请刷新页面后重试。");
      return;
    }
    setSavingUserId(user.id);
    setError("");
    try {
      const response = await updateAdminUser(user.id, patch, csrfToken);
      setUsers((current) => current.map((item) => item.id === user.id ? response.user : item));
      if (response.user.id === currentUserId) {
        onCurrentUserUpdated(response.user);
      }
      if (patch.role === "admin") {
        onNotice(`${user.displayName} 已成为管理员`);
      } else if (patch.role) {
        onNotice(`${user.displayName} 的角色已调整为${roleLabel(patch.role)}`);
      } else if (patch.trustLevel !== undefined) {
        onNotice(`${user.displayName} 的等级已设为 Lv${patch.trustLevel}`);
      } else {
        onNotice(`${user.displayName} 的等级管理方式已更新`);
      }
    } catch (requestError) {
      if (requestError instanceof ApiRequestError && requestError.status === 401) {
        authRequiredRef.current();
      } else {
        setError(adminFailureMessage(requestError));
      }
    } finally {
      setSavingUserId(null);
    }
  };

  const submitCategory = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!csrfToken || creatingCategory) {
      if (!csrfToken) setError("会话安全令牌不可用，请刷新页面后重试。");
      return;
    }
    setCreatingCategory(true);
    setError("");
    try {
      const response = await createAdminCategory(
        {
          ...categoryForm,
          slug: categoryForm.slug.trim().toLocaleLowerCase("en-US"),
          name: categoryForm.name.trim(),
          description: categoryForm.description.trim(),
        },
        csrfToken,
      );
      setCategories((current) => [...current, response.category].sort((left, right) => left.position - right.position));
      setCategoryForm(EMPTY_CATEGORY);
      onCategoryCreated();
      onNotice(`板块“${response.category.name}”已经开设`);
    } catch (requestError) {
      if (requestError instanceof ApiRequestError && requestError.status === 401) {
        authRequiredRef.current();
      } else {
        setError(adminFailureMessage(requestError));
      }
    } finally {
      setCreatingCategory(false);
    }
  };

  const revokeInvite = async (inviteId: string) => {
    if (!csrfToken || revokingId) {
      if (!csrfToken) setError("会话安全令牌不可用，请刷新页面后重试。");
      return;
    }
    setRevokingId(inviteId);
    setError("");
    try {
      const response = await revokeAdminInvite(inviteId, csrfToken);
      setInvites((current) => current.map((item) => item.id === inviteId ? response.invite : item));
      setConfirmRevokeId(null);
      onNotice("邀请已撤销");
    } catch (requestError) {
      if (requestError instanceof ApiRequestError && requestError.status === 401) {
        authRequiredRef.current();
      } else {
        setError(adminFailureMessage(requestError));
      }
    } finally {
      setRevokingId(null);
    }
  };

  return (
    <main className="admin-page" id="main-content">
      <header className="review-hero admin-hero">
        <div>
          <p className="eyebrow">ADMIN · 站点管理</p>
          <h1>保持社区可进入、可恢复</h1>
          <p>在这里开设板块、安排管理员与成员等级，并控制维护和注册邀请。</p>
        </div>
        <button className="button button-secondary" onClick={onExit} type="button">返回社区</button>
      </header>

      {error && <div className="admin-error" role="alert">{error}</div>}

      {status === "loading" && (
        <section aria-busy="true" className="admin-loading">
          <span className="spinner" aria-hidden="true" /> 正在读取管理设置与邀请…
        </section>
      )}

      {status === "error" && (
        <section className="review-state review-error" role="alert">
          <div aria-hidden="true">!</div>
          <h2>管理资料暂时没有送达</h2>
          <p>{error}</p>
          <button className="button button-secondary" onClick={() => setRefreshVersion((value) => value + 1)} type="button">重新读取</button>
        </section>
      )}

      {status === "ready" && (
        <>
          <section className="admin-control-grid" aria-label="站点控制">
            <article className={maintenanceMode ? "admin-control-card is-alert" : "admin-control-card"}>
              <p className="eyebrow">写入控制</p>
              <h2>{maintenanceMode ? "维护模式已开启" : "社区正常运行"}</h2>
              <p>{maintenanceMode ? "普通成员仍可阅读，但发帖、回复、互动、举报与上传会被服务端拒绝。" : "普通成员可按权限正常发布、回复与互动。"}</p>
              <button
                className={maintenanceMode ? "button button-primary" : "button button-secondary"}
                disabled={savingMaintenance}
                onClick={() => void toggleMaintenance()}
                type="button"
              >
                {savingMaintenance ? "正在保存…" : maintenanceMode ? "关闭维护并恢复写入" : "开启只读维护"}
              </button>
            </article>

            <article className="admin-control-card">
              <p className="eyebrow">注册邀请</p>
              <h2>创建一次性邀请</h2>
              <p>每枚邀请只能成功注册一个账号。服务器只保存不可逆摘要，原始链接离开本页后无法找回。</p>
              <button className="button button-primary" disabled={creatingInvite} onClick={() => void createInvite()} type="button">
                {creatingInvite ? "正在安全生成…" : "生成新邀请"}
              </button>
            </article>
          </section>

          <section className="admin-management-section" aria-labelledby="category-admin-title">
            <div className="admin-section-heading">
              <div>
                <p className="eyebrow">板块管理</p>
                <h2 id="category-admin-title">开设新板块</h2>
              </div>
              <span className="admin-section-count">{categories.length} 个板块</span>
            </div>

            <form className="admin-category-form" onSubmit={(event) => void submitCategory(event)}>
              <label>
                <span>板块名称</span>
                <input
                  maxLength={40}
                  onChange={(event) => setCategoryForm((current) => ({ ...current, name: event.target.value }))}
                  placeholder="例如：工程技术"
                  required
                  value={categoryForm.name}
                />
              </label>
              <label>
                <span>网址标识</span>
                <input
                  autoCapitalize="none"
                  maxLength={60}
                  minLength={2}
                  onChange={(event) => setCategoryForm((current) => ({ ...current, slug: event.target.value.toLocaleLowerCase("en-US") }))}
                  pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
                  placeholder="engineering"
                  required
                  value={categoryForm.slug}
                />
                <small>使用小写英文、数字和连字符</small>
              </label>
              <label className="admin-category-description">
                <span>板块说明</span>
                <textarea
                  maxLength={240}
                  onChange={(event) => setCategoryForm((current) => ({ ...current, description: event.target.value }))}
                  placeholder="告诉成员这里适合讨论什么"
                  rows={3}
                  value={categoryForm.description}
                />
              </label>
              <label>
                <span>可见范围</span>
                <select
                  onChange={(event) => setCategoryForm((current) => ({ ...current, aclMode: event.target.value as CreateAdminCategoryInput["aclMode"] }))}
                  value={categoryForm.aclMode}
                >
                  <option value="open">公开可见</option>
                  <option value="restricted">仅登录成员</option>
                </select>
              </label>
              <label>
                <span>阅读门槛</span>
                <select
                  onChange={(event) => {
                    const minViewLevel = trustLevelValue(event.target.value);
                    setCategoryForm((current) => ({
                      ...current,
                      minViewLevel,
                      minCreateLevel: atLeastTrustLevel(current.minCreateLevel, minViewLevel),
                      minReplyLevel: atLeastTrustLevel(current.minReplyLevel, minViewLevel),
                      allowedTopicMinLevelMax: atLeastTrustLevel(current.allowedTopicMinLevelMax, minViewLevel),
                    }));
                  }}
                  value={categoryForm.minViewLevel}
                >
                  {TRUST_LEVELS.map((item) => <option key={item} value={item}>Lv{item}</option>)}
                </select>
              </label>
              <label>
                <span>发主题门槛</span>
                <select
                  onChange={(event) => setCategoryForm((current) => ({ ...current, minCreateLevel: trustLevelValue(event.target.value) }))}
                  value={categoryForm.minCreateLevel}
                >
                  {TRUST_LEVELS.map((item) => <option disabled={item < categoryForm.minViewLevel} key={item} value={item}>Lv{item}</option>)}
                </select>
              </label>
              <label>
                <span>回复门槛</span>
                <select
                  onChange={(event) => setCategoryForm((current) => ({ ...current, minReplyLevel: trustLevelValue(event.target.value) }))}
                  value={categoryForm.minReplyLevel}
                >
                  {TRUST_LEVELS.map((item) => <option disabled={item < categoryForm.minViewLevel} key={item} value={item}>Lv{item}</option>)}
                </select>
              </label>
              <label>
                <span>主题最高可见等级</span>
                <select
                  onChange={(event) => setCategoryForm((current) => ({ ...current, allowedTopicMinLevelMax: trustLevelValue(event.target.value) }))}
                  value={categoryForm.allowedTopicMinLevelMax}
                >
                  {TRUST_LEVELS.map((item) => <option disabled={item < categoryForm.minViewLevel} key={item} value={item}>Lv{item}</option>)}
                </select>
              </label>
              <label className="admin-color-field">
                <span>识别色</span>
                <div>
                  <input
                    aria-label="选择板块颜色"
                    onChange={(event) => setCategoryForm((current) => ({ ...current, color: event.target.value }))}
                    type="color"
                    value={categoryForm.color}
                  />
                  <code>{categoryForm.color}</code>
                </div>
              </label>
              <label className="admin-check-field">
                <input
                  checked={categoryForm.allowImages}
                  onChange={(event) => setCategoryForm((current) => ({ ...current, allowImages: event.target.checked }))}
                  type="checkbox"
                />
                <span>允许主题上传图片</span>
              </label>
              <div className="admin-category-submit">
                <button className="button button-primary" disabled={creatingCategory} type="submit">
                  {creatingCategory ? "正在开设…" : "开设板块"}
                </button>
                <small>权限会在服务端立即生效。</small>
              </div>
            </form>

            {categories.length > 0 && (
              <div className="admin-category-list" aria-label="现有板块">
                {categories.map((item) => (
                  <span key={item.id} style={{ "--category-color": item.color } as CSSProperties}>
                    <i aria-hidden="true" />
                    {item.name}
                    <small>{item.aclMode === "open" ? "公开" : "成员"} · Lv{item.minViewLevel}+</small>
                  </span>
                ))}
              </div>
            )}
          </section>

          <section className="admin-management-section" aria-labelledby="user-admin-title">
            <div className="admin-section-heading admin-user-heading">
              <div>
                <p className="eyebrow">成员与权限</p>
                <h2 id="user-admin-title">管理员与信任等级</h2>
              </div>
              <form className="admin-user-search" onSubmit={(event) => void searchUsers(event)} role="search">
                <label>
                  <span className="visually-hidden">搜索成员</span>
                  <input
                    maxLength={80}
                    onChange={(event) => setUserQuery(event.target.value)}
                    placeholder="用户名、昵称或邮箱"
                    type="search"
                    value={userQuery}
                  />
                </label>
                <button className="button button-secondary" disabled={searchingUsers} type="submit">
                  {searchingUsers ? "搜索中…" : "搜索"}
                </button>
              </form>
            </div>

            {users.length === 0 ? (
              <div className="admin-empty">{appliedUserQuery ? "没有找到匹配的成员。" : "社区里还没有成员。"}</div>
            ) : (
              <div className="admin-user-table" role="table" aria-label="成员权限列表">
                {users.map((user) => {
                  const busy = savingUserId === user.id;
                  const anotherUserBusy = savingUserId !== null && !busy;
                  const isSelf = user.id === currentUserId;
                  return (
                    <article className="admin-user-row" key={user.id} role="row">
                      <div className="admin-user-identity">
                        <span className={`user-status user-status-${user.status}`}>{userStatusLabel(user.status)}</span>
                        <strong>{user.displayName}{isSelf ? "（你）" : ""}</strong>
                        <small>@{user.username}{user.email ? ` · ${user.email}` : ""}</small>
                      </div>
                      <label>
                        <span>角色</span>
                        <select
                          aria-label={`设置 ${user.displayName} 的角色`}
                          disabled={busy || anotherUserBusy || isSelf || user.status !== "active"}
                          onChange={(event) => void changeUser(user, { role: event.target.value as AdminUserRole })}
                          value={user.role}
                        >
                          <option value="member">成员</option>
                          <option value="moderator">版主</option>
                          <option value="admin">管理员</option>
                        </select>
                        {isSelf && <small>不能在这里更改自己的角色</small>}
                      </label>
                      <label>
                        <span>信任等级</span>
                        <select
                          aria-label={`设置 ${user.displayName} 的信任等级`}
                          disabled={busy || anotherUserBusy || user.status === "deleted"}
                          onChange={(event) => {
                            const trustLevel = trustLevelValue(event.target.value);
                            void changeUser(user, { trustLevel, levelLocked: true });
                          }}
                          value={user.trustLevel}
                        >
                          {TRUST_LEVELS.map((item) => <option key={item} value={item}>Lv{item}</option>)}
                        </select>
                        <small>手动改级后会锁定</small>
                      </label>
                      <label className="admin-level-lock">
                        <input
                          checked={user.levelLocked}
                          disabled={busy || anotherUserBusy || user.status === "deleted" || user.trustLevel === 4}
                          onChange={(event) => void changeUser(user, { levelLocked: event.target.checked })}
                          type="checkbox"
                        />
                        <span>{user.trustLevel === 4 ? "Lv4 仅手动管理" : user.levelLocked ? "保持手动等级" : "允许自动升降级"}</span>
                      </label>
                      <span className="admin-user-save-state" aria-live="polite">{busy ? "正在保存…" : roleLabel(user.role)}</span>
                    </article>
                  );
                })}
              </div>
            )}

            {userNextCursor && (
              <button className="load-more review-load-more" disabled={loadingMoreUsers} onClick={() => void loadMoreUsers()} type="button">
                {loadingMoreUsers ? "正在载入…" : "继续载入更多成员"}
              </button>
            )}
          </section>

          {createdToken && (
            <section aria-live="polite" className="created-invite-card">
              <div>
                <p className="eyebrow">仅显示这一次</p>
                <h2>{siteName} 注册邀请</h2>
                <p>请立即复制并通过可信渠道发送。关闭此卡或离开管理页后，链接不会保留。</p>
              </div>
              <label>
                <span>邀请链接</span>
                <input onFocus={(event) => event.currentTarget.select()} readOnly value={inviteRegistrationUrl(createdToken)} />
              </label>
              <div className="created-invite-actions">
                <button className="button button-primary" onClick={() => void copyInvite()} type="button">
                  {copyState === "copied" ? "已复制" : "复制邀请链接"}
                </button>
                <button className="button button-quiet" onClick={() => { setCreatedToken(null); setCopyState("idle"); }} type="button">我已妥善保存</button>
                {copyState === "failed" && <small role="alert">浏览器拒绝自动复制，请手动选择上方链接。</small>}
              </div>
            </section>
          )}

          <section className="admin-invite-list" aria-labelledby="invite-list-title">
            <div className="admin-section-heading">
              <div>
                <p className="eyebrow">邀请记录</p>
                <h2 id="invite-list-title">最近创建的邀请</h2>
              </div>
              <button className="review-refresh" onClick={() => setRefreshVersion((value) => value + 1)} type="button"><span aria-hidden="true">↻</span> 刷新</button>
            </div>

            {invites.length === 0 ? (
              <div className="admin-empty">还没有邀请。创建后，这里只显示状态，不会显示原始 token。</div>
            ) : (
              <div className="admin-invite-table" role="table" aria-label="邀请列表">
                {invites.map((invite) => (
                  <article className="admin-invite-row" key={invite.id} role="row">
                    <div>
                      <span className={`invite-status invite-status-${invite.status}`}>{inviteStatusLabel(invite)}</span>
                      <strong>{invite.id.slice(0, 8)}</strong>
                      <small>由 {invite.createdBy.displayName} 创建 · {formatDate(invite.createdAt)}</small>
                    </div>
                    <div className="invite-usage"><strong>{invite.usedCount}/{invite.maxUses}</strong><small>已使用</small></div>
                    <div className="invite-row-actions">
                      {invite.status === "active" && confirmRevokeId !== invite.id && (
                        <button className="button button-quiet" onClick={() => setConfirmRevokeId(invite.id)} type="button">撤销</button>
                      )}
                      {invite.status === "active" && confirmRevokeId === invite.id && (
                        <>
                          <button className="button button-danger" disabled={revokingId === invite.id} onClick={() => void revokeInvite(invite.id)} type="button">
                            {revokingId === invite.id ? "正在撤销…" : "确认撤销"}
                          </button>
                          <button className="button button-quiet" disabled={revokingId === invite.id} onClick={() => setConfirmRevokeId(null)} type="button">取消</button>
                        </>
                      )}
                    </div>
                  </article>
                ))}
              </div>
            )}

            {nextCursor && (
              <button className="load-more review-load-more" disabled={loadingMore} onClick={() => void loadMore()} type="button">
                {loadingMore ? "正在载入…" : "继续载入更早的邀请"}
              </button>
            )}
          </section>
        </>
      )}
    </main>
  );
}
