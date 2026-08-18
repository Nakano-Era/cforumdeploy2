# CForum

CForum 是一个从零实现的 Cloudflare-native 中文轻量论坛。它参考 Discourse 的信息架构、信任等级、板块 ACL、通知和审核理念，但不依赖 Ruby/Rails、PostgreSQL、Redis、Sidekiq、VPS 或常驻服务器。

## 当前状态

目前已完成 Cloudflare 原生基础设施与主要 P0 纵向功能；仓库可以本地构建和 dry-run，但真实域名、仓库地址及第三方服务仍需部署者配置：

- React + Vite SPA，由 Workers Static Assets 直接提供；仅 `/api/*` 进入 Worker。
- Hono Worker，同时提供 Fetch、Queue Consumer 与 Scheduled Handler。
- D1 版本化 migrations，覆盖账号、Passkey、会话、邀请、等级、板块、主题、互动、通知、审核、媒体、容量和审计数据。
- 中央权限服务：Guest/Lv0–Lv4、等级与 Group ACL 交集、精确板块版主范围、管理员策略、作者降级只读和附件继承。
- 8,200+ 项权限、安全、认证、媒体、搜索、互动、维护模式和管理后台测试，包含完整等级/ACL 参数化矩阵。
- 首次安装管理员、公开站点配置、健康检查、三种注册模式、邮箱 OTP、Turnstile、Passkey 与可吊销 Cookie Session。
- 综合/最新/热门/关注/未读 Feed、FTS 搜索、板块、主题/回复、幂等点赞/收藏与 Lv0 审核入口。
- 浏览器图片方向修正、元数据剥离、自适应压缩、R2 批量上传许可、Lv0–Lv4 每日额度、7/8GB 软硬闸门、SigV4 直传、finalize、帖子绑定与受控读取。
- 中文响应式论坛界面、安装向导、真实登录/注册/发帖/回复/互动流程、通知面板、staff 审核工作台、非阻断 Passkey 强提示、深色模式和基础无障碍交互。
- Lv1–Lv3 定时升降级、活动统计、保护期/预警/通知/审计，以及可配置等级规则。
- Active Admin 管理能力：可恢复只读维护模式，开设公开或成员板块，搜索成员、任命多位管理员、手动调整并锁定信任等级，在主题详情置顶或取消置顶，以及创建、列出和撤销一次性注册邀请；原始邀请 token 仅创建时返回一次。
- `maintenance_mode` 由服务端中央 middleware 强制：普通成员和版主的业务 mutation 统一返回 `503 / SITE_MAINTENANCE`，安全方法与登录恢复链保持可用，状态正常的 Admin 可绕过并关闭维护。

仍在后续阶段内、不得视为已完成的功能包括：恢复码/账号恢复、板块编辑与完整 Group/自定义 ACL、用户状态与 session 管理、资料与草稿/编辑历史、完整关注通知、徽章、用量仪表板、备份恢复自动化及容量合成测试。详见 [已知限制](#已知限制)。

## 架构

```text
浏览器
  ├─ HTML / JS / CSS ──> Workers Static Assets
  ├─ /api/* ───────────> Worker ──> D1
  ├─ 邮件任务 ──────────> Queue ──> Resend
  ├─ 图片写入 ──────────> Worker 授权 ──> Presigned PUT ──> R2
  └─ 图片读取 ──────────> /api/media/:id ──> 权限复核 ──> Public/Private R2
```

Cloudflare 配置位于 [`wrangler.jsonc`](./wrangler.jsonc)，声明一个 D1、两个 R2 bucket、一个 Queue、DLQ、Static Assets 和 Cron。所有运行组件均为 Serverless。

## 本地开发

要求 Node.js 22 或更高版本。

```bash
npm install
cp .dev.vars.example .dev.vars
npm run db:migrate
npm run dev:full
```

Windows PowerShell 可使用：

```powershell
Copy-Item .dev.vars.example .dev.vars
npm.cmd run db:migrate
npm.cmd run dev:full
```

在 `.dev.vars` 中至少设置四个彼此独立、长度不少于 32 字节的随机值：

- `SESSION_HMAC_SECRET`
- `OTP_HMAC_SECRET`
- `INVITE_HMAC_SECRET`
- `WEBAUTHN_CHALLENGE_SECRET`

同时设置一次性的 `BOOTSTRAP_ADMIN_SECRET`。不要把 `.dev.vars`、OTP、Cookie、邀请令牌或完整 Presigned URL 提交到仓库或写入日志。

前端默认位于 `http://127.0.0.1:5173`，Worker 位于 `http://127.0.0.1:8787`；Vite 会把 `/api` 代理给 Worker。首次打开时安装向导会要求站名、管理员资料、注册模式和 bootstrap secret。

## 验证命令

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

`npm run build` 会先构建静态资源，再执行 Wrangler dry-run，验证 Worker bundle 和全部绑定，但不会发布。

## 部署到 Cloudflare

第一次部署请先按 [`docs/deployment-guide-beginner.md`](./docs/deployment-guide-beginner.md) 的 Windows PowerShell 小白教程操作；它包含首次资源创建、生产 Secret、R2 CORS、邮箱和上线验收的完整顺序。


[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Nakano-Era/cforum)

Deploy to Cloudflare 会读取 `wrangler.jsonc` 并创建/绑定 D1、R2 和 Queue。Turnstile widget、Resend API Key 与 R2 S3 API Token 不能自动创建，仍需部署者在 Cloudflare 控制台或部署表单中配置。

部署前必须：

1. 把 `APP_ORIGIN` 改为最终的 `https://*.workers.dev` 或自定义域名；它用于 CSRF 和 WebAuthn origin 校验。
2. 创建 Turnstile widget，允许最终主机名，并填写 `TURNSTILE_SITE_KEY` 与 `TURNSTILE_SECRET`。
3. 验证 Resend 发信域名，填写 `RESEND_API_KEY` 与 `EMAIL_FROM`。生产环境未配置邮件时，公开验证码注册会 fail closed。
4. 为直传目标 `cforum-private-media` 创建最小权限的 R2 Object Read & Write S3 凭据，填写 `R2_ACCOUNT_ID`、`R2_ACCESS_KEY_ID`、`R2_SECRET_ACCESS_KEY`；Public bucket 由 Worker binding 访问。
5. 保持两个 R2 bucket 都不公开：不要绑定公开媒体域名，也不要启用 `r2.dev`。公共与受限图片都经 `/api/media/:uploadId` 重新授权。
6. 只为直传目标配置允许最终站点来源的精确 CORS（`PUT`、`Content-Type`、`x-amz-checksum-sha256`）；临时对象由每小时 Cron 清理，无需公开 bucket 或额外生命周期规则。

CLI 部署：

```bash
npm run deploy
```

该脚本依次执行生产构建、远端 D1 migrations、Worker 部署。首次纯 CLI 部署时，如果账户未启用 Wrangler 自动资源配置，应先用 Wrangler 创建资源并让配置包含真实绑定；Deploy Button 流程会在构建前完成资源配置。

Cloudflare 官方资料：[Deploy Button](https://developers.cloudflare.com/workers/platform/deploy-buttons/)、[Static Assets SPA](https://developers.cloudflare.com/workers/static-assets/routing/single-page-application/)、[D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/)、[R2 Presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/)。

## 权限不变量

- Guest 的读取等级按 Lv0 计算，因此 `min_view_level=0` 可以公开；仍必须同时满足 Category ACL。
- Group ACL 不覆盖等级门槛，二者必须同时成立；受限 ACL 空记录时 fail closed。
- Create、Reply、See 是独立授权，Create/Reply 都要求 See。
- 版主只管理明确分配给自己的板块，跨板块移动需要同时拥有来源和目标权限。
- 作者降级后仅在仍满足 Group ACL 时保留自己高等级主题的只读访问；主题产生全局作者降级锁，恢复等级后只解除该派生锁。
- 不可见对象统一返回 404；列表、搜索、计数、通知和媒体必须使用同一个可见性策略。
- 已绑定媒体的权限来自父主题，上传所有者不能绕过父主题。

详细决策见 [`docs/adr/0002-permission-model.md`](./docs/adr/0002-permission-model.md)。

## 管理后台

只有具有有效 session、状态为 `active` 的 Admin 可以调用管理接口；所有修改请求仍须携带 CSRF token。

- `GET /api/admin/users` 按 keyset 游标列出或搜索成员；`PATCH /api/admin/users/:id` 可独立修改角色、信任等级和手动等级锁。任命 Admin 不会隐式改变其信任等级，两者是独立权限维度。
- 系统允许任命多位 Admin，但不存在更高一级的“超级管理员”。API 与数据库 migration 会共同阻止撤销、停权或删除最后一名 active Admin。
- 手动修改信任等级默认同时锁定等级，避免下一次定时复核覆盖；解除锁定后，该成员会重新进入自动等级复核。Lv4 始终只允许手工授予。等级变化会写入历史、通知和审计。
- `GET /api/admin/categories` 列出板块；`POST /api/admin/categories` 开设顶层板块。`open` 表示 ACL 公开读取、登录成员可写；`restricted` 会创建仅登录成员适用的 `see/reply/create` 授权。ACL 与等级门槛始终同时生效。
- `PATCH /api/topics/:id/pin` 接受显式 `desired` 状态，供 Active Admin 幂等置顶或取消置顶已发布主题。实际变化分别记录 `topic.pin` 或 `topic.unpin` 审计；安全重试不会重复写入审计。
- 当前界面尚不提供板块编辑/归档、Group ACL、版主板块 scope、用户停权或 session 撤销；这些能力不应通过绕过严格请求 schema 的方式模拟。

更完整的操作说明见 [`docs/admin-guide.md`](./docs/admin-guide.md)。

## 数据库与 migrations

所有 schema 变更放入 `migrations/`，不得直接修改生产库。当前空库会依次执行 `0001_initial.sql`、`0002_invites_admin_list.sql`、`0003_user_avatars.sql`、`0004_admin_management.sql` 与 `0005_feed_metrics_indexes.sql`。发布后不得再修改已经执行过的 migration，而应新增递增版本。

主要列表必须使用 keyset cursor。发布前对真实查询执行 `EXPLAIN QUERY PLAN`，并把索引证据、预期 `rows_read` 与合成数据结果记录下来。

## 已知限制

本仓库仍处于分阶段实施期：

- Feed API 已实现权限过滤与游标；部分社区聚合仍需进一步容量校准，heartbeat 只能限频限幅，不能证明用户持续注视页面。
- FTS 搜索 API 已做权限过滤、安全字面量查询和游标分页；CJK 分词质量调优、搜索限速及接近额度时的降级策略尚未完成。
- Passkey 注册/登录及客户端强提示已完成；一次性恢复码与账号恢复流程尚未完成。
- 图片本地优化、R2 许可/finalize/绑定、Public/Private 安全搬运、受控 GET 和孤儿回收已完成；主题创建请求尚无 `Idempotency-Key`，若服务端已创建而响应在网络中丢失，仍存在重复主题风险。
- Admin 维护恢复、板块创建、多管理员、手动等级、主题置顶、一次性邀请与 staff 审核界面已完成；板块编辑/归档、Group/自定义 ACL、版主 scope、用户状态/session、邀请邮箱/域名/多次使用/过期、容量仪表板等完整后台仍未完成。
- 举报、注册/首帖/媒体审核决定、自动隐藏、通知和审计已实现；完整内容编辑、软删除/恢复与申诉产品面尚未完成。
- Lv1–Lv3 定时升级/降级已实现；处罚历史仍兼容既有 moderation action，尚无独立结构化 sanction 表。
- 主题/回复/搜索/举报尚未实现全部按等级可配置日限额，高风险发帖尚未接入额外 Turnstile。
- 尚未执行 30,000 用户/80,000 内容的最终容量与恢复演练；任何规模数字均仍是设计目标，不是实测结果

## 进一步文档

- [Cloudflare 原生架构 ADR](./docs/adr/0001-cloudflare-native.md)
- [权限模型 ADR](./docs/adr/0002-permission-model.md)
- [认证模型 ADR](./docs/adr/0003-authentication.md)
- [媒体模型 ADR](./docs/adr/0004-media.md)
- [容量与升级路线 ADR](./docs/adr/0005-capacity.md)
- [管理员手册](./docs/admin-guide.md)
- [备份与恢复](./docs/backup-restore.md)
