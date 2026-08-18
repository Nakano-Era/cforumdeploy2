# CForum 续开发交接（给下一位 AI）

更新时间：2026-08-18（Asia/Taipei）

这是一份可直接作为新对话首条上下文使用的工程交接。不要从 Discourse 仓库起步，也不要改写为 Ruby/Rails、PostgreSQL、Redis 或 Sidekiq；当前仓库已经是从零实现的 Cloudflare-native TypeScript 项目。

## 1. 新对话开始时先做什么

1. 当前工作目录：`C:\Users\123\Desktop\project\CForum`。
2. 先读本文件、`README.md`、`docs/adr/0002-permission-model.md`、`docs/adr/0004-media.md`，再读仓库根目录的用户原始任务书 `cloudflare-forum-ai-handoff.md`。
3. 运行 `git status --short`。当前项目从空目录创建，所有文件可能仍显示为未跟踪；它们都是已有成果，不得删除、reset 或用模板覆盖。
4. 运行以下基线检查：

   ```powershell
   npm.cmd run typecheck
   npm.cmd run lint
   npm.cmd test -- --reporter=dot
   npm.cmd run build
   ```

   如果当前 Codex 终端没有系统 Node/npm，先加载 Codex workspace dependencies 并直接调用随附 Node；这属于运行环境差异，不代表仓库失败。

5. 不要先写新架构方案；先核对“第 9 节：下一步顺序”，然后直接实现一个可验证的纵向切片。

## 2. 用户已经最终确认的语义

这些是用户直接确认的要求，优先于任务书中含糊或冲突的描述：

1. `min_view_level=0` 允许游客查看，但只代表等级维度通过。
2. 等级门槛与 Category/Group ACL 必须同时满足；ACL 不得覆盖等级。
3. 版主只能管理 `moderator_category_scopes` 明确分配给自己的板块。
4. 主题作者降级后，只要仍满足 Group ACL，就能继续查看自己曾发布的高等级主题；此时整题为只读并禁止所有人继续回复。作者等级恢复后仅解除该派生锁，手工锁继续保留。
5. Passkey 不是强制，但注册后必须有醒目的非阻断强提示。
6. Lv0 前若干主题/回复进入审核的阈值由后台配置，`0` 表示关闭。

项目定位是 Discourse-like lightweight forum，不追求完整复刻。业务系统和数据模型独立实现；认证、WebAuthn、Markdown 清洗、输入验证、加密和 SigV4 必须优先使用成熟库或平台能力，不得自行设计密码学算法。

## 3. 不可改变的架构边界

- React + Vite SPA，由 Workers Static Assets 提供。
- Hono Worker 只优先处理 `/api/*`；静态资源不经过 Worker。
- D1 保存业务数据，FTS5 搜索。
- 两个 R2 binding：`PUBLIC_MEDIA` 与 `PRIVATE_MEDIA`。
- Queue 发送邮件；Cron 处理等级复核、媒体清理和一般维护。
- Turnstile 用于邮件验证码与注册；Passkey 使用 SimpleWebAuthn。
- 只使用 Cookie session；session token 仅以 HMAC 保存，CSRF 使用 double-submit cookie + 服务端哈希。
- 所有数据库变更必须使用 migration。当前已有 `0001_initial.sql` 与 `0002_invites_admin_list.sql`；正式环境执行后都不得改写，后续应新增 `0003_*.sql`。

媒体实现有一项有意偏离原任务书：Public/Private R2 都不直接暴露对象 URL，浏览器统一访问 `/api/media/:uploadId`。Worker 会按当前帖子、主题等级和 Category ACL 重新授权。`PUBLIC_MEDIA` bucket 不得绑定公开自定义域名，也不得启用 `r2.dev`，否则会绕过权限收紧后的检查。这个设计更强地保护权限，但会增加 Worker 图片请求；后续做容量验证时必须量化这个权衡，不能悄悄改回公开直链。

## 4. 已实现的系统

### 基础设施与数据

- `wrangler.jsonc` 已声明 Static Assets、D1、两个 R2、Queue/DLQ 与三个 Cron。
- `migrations/0001_initial.sql` 与 `0002_invites_admin_list.sql` 可依次在全新本地 D1 执行；`0002` 只新增 Admin 邀请 keyset 列表索引，没有改写已执行的 `0001`。
- Schema 覆盖账号、邮箱、Passkey、session、邀请、用户组、等级、板块 ACL、主题/帖子、FTS、互动、通知、审核、媒体、用量和审计。
- `src/worker/index.ts` 同时导出 Fetch、Queue consumer 与 Scheduled handler。

### 权限

- 中央策略：`src/worker/permissions/policy.ts`。
- SQL 可见性：`src/worker/permissions/visibility-scope.ts`。
- 已覆盖 Guest/Lv0–Lv4、Group ACL 交集、精确板块版主、管理员、作者降级只读和附件继承。
- 不可见对象统一 404；Feed、搜索、通知和媒体均重新应用当前权限。
- 参数化权限矩阵占测试总数的大部分，不能为减少测试数量而删除。

### 认证与注册

- Bootstrap 安装向导和一次性 bootstrap claim。
- `open | approval | invite_only` 三种注册模式的数据与注册路径。
- Active Admin 可创建、keyset 列出和幂等撤销一次性邀请；原 token 仅创建响应返回一次，D1 只保存 HMAC，审计不含 token/hash。
- 注册消费使用 OTP update → invite guarded update → user insert 的双 `changes()` 守卫；注册模式、冻结值、邀请审批值和禁用域名设置异常时 fail closed。
- 邮箱 OTP：Turnstile、统一响应、防枚举、HMAC code、一次性消费、限速、Queue。
- Passkey 注册/登录：SimpleWebAuthn、一次性 challenge、原子消费与 session 写入。
- 可吊销 Cookie session、内存 CSRF token、注销当前 session。
- 注册后非阻断 Passkey 强提示。

### 论坛核心与前端

- 综合、最新、热门、关注、未读 Feed；板块/等级/搜索筛选；keyset cursor。
- FTS 搜索、字面量通配符处理、权限过滤。
- 创建主题、主题详情、回复、Markdown GFM + `rehype-sanitize`，不启用原始 HTML。
- History API `/t/:id`、通知定位到帖子、浏览器前进/后退。
- 幂等 `desired:boolean` 点赞和收藏，客户端乐观更新/回滚。
- 中文响应式界面、深色模式、键盘焦点、reduced-motion、loading/error/empty 状态。
- Admin 管理工作台已接入：可开关只读维护、生成/复制/撤销一次性邀请；`?invite=` 链接会预填注册 token，成功消费后从地址栏移除。
- 全站维护横幅与主要 mutation 错误映射已接入；普通成员前端会提前阻止发帖、收藏和举报，服务端仍是最终安全边界。

### 信任等级

- `src/worker/trust/*` 实现 Lv1/Lv2/Lv3 自动升降级；Lv4 仅手工。
- 日活动计量覆盖主题、回复、点赞、主题阅读和限幅 reading heartbeat。
- Lv2 非活跃降级不会立即振荡回升。
- Lv3 分母只统计候选用户有权查看的内容。
- 严重举报、处罚、保护期、预警、历史、通知、审计和邮件 outbox 已实现。
- `*/15 * * * *` Cron 小批量处理到期用户。
- Admin 等级规则 GET/PATCH API 已实现并挂载。

### 举报、审核与通知

- 举报：`POST /api/posts/:id/reports`，同用户/帖子/类型幂等。
- 审核：`GET /api/admin/review` 与 `POST /api/admin/review/:id/decision`。
- Admin 全站；Moderator 仅精确板块范围。越权与不存在统一 404。
- 注册、首帖/回复、媒体帖和举报处理使用 D1 batch、guarded update、审计和通知。
- 举报接受会隐藏帖子；首帖被隐藏时删除主题并重算计数。
- 前端已有举报弹窗、staff 审核工作区和通知面板。
- 通知读取前重新检查权限；目标失效时仅返回通用事件，不返回标题、摘要或链接。

### 媒体服务端

- `POST /api/uploads/authorize`：Lv 配额、7/8GB 软硬闸门、SigV4 Presigned PUT。
- `POST /api/uploads/finalize`：R2 HEAD/头部读取，校验 checksum、MIME、magic bytes、尺寸和归属。
- `POST /api/uploads/bind`：绑定到本人帖子；Public/Private 由真实 Guest 权限决定。
- `GET|HEAD /api/media/:uploadId[/:variant]`：统一受控读取、404 concealment、ETag/304、公共短缓存、私密 no-store。
- Public/Private 重分类使用“复制到随机目标键 → D1 guarded switch → 删除旧键”，竞态失败者补偿清理。
- 审核批准后会在 `waitUntil` 中重算绑定媒体 scope。
- 每小时 `7 * * * *` Cron 最多连续清四页临时/孤儿对象；失败抛错以触发重试，R2 cursor 持久化。

### 前端图片切片

已完成 `src/client/imageOptimization.ts`、`src/client/media.ts`、`pendingMediaBindings.ts` 与 Compose 集成：方向修正、元数据剥离、主图/缩略图自适应压缩、checksum、authorize/PUT/finalize/topic/bind、临时清理和 object URL 回收均已落地。

两个接手时发现的 P0 竞态已修复：所有签名 PUT 使用 `Promise.allSettled`，全部落定后才可清理；bind job 按 userId 持久保存且只含 `topicId/postId/uploadIds`，关闭/刷新后可恢复，不保存 CSRF、正文、token 或图片数据。仍未实现主题创建 `Idempotency-Key`，网络丢失成功响应时可能产生重复主题，见第 10 节。

## 5. 关键 API 契约

- `GET /api/feed`：服务端先过滤权限；返回 `topics/categories/viewer/pulse/nextCursor`。
- Category 现在返回 `allowImages`、`canCreate`、`allowedTopicMinLevelMax`，Compose 必须据此限制 UI。
- `POST /api/topics` 成功响应包含 `topic.id`、`topic.firstPostId`、`slug/status/reviewRequired`。
- `GET /api/topics/:id` 返回 camelCase topic、posts、tags、`access.readOnly/canReply/replyReason/via`。
- `POST /api/topics/:id/replies`：201 published；202 pending review。
- `POST /api/posts/:id/reactions`：body 必须含 `{type:"like", desired:boolean}`，禁止 toggle 语义。
- `POST /api/posts/:id/bookmark`：body `{desired:boolean}`。
- `GET|POST /api/admin/invites` 与 `PATCH /api/admin/invites/:id`：仅 active Admin；P0 只允许 `{maxUses:1}` 与 `{revoked:true}`。
- 维护开启时，active Admin 在设置查询前 bypass；其余非安全业务 mutation 统一 `503 {error:{code:"SITE_MAINTENANCE"}}`。登录恢复链、Bootstrap、logout 以及 GET/HEAD/OPTIONS 保持可用。
- 所有 authenticated mutation 都要带内存中的 `X-CSRF-Token`；不得把 CSRF/session/OTP/邀请 token 写入 localStorage。

## 6. 必须持续保持的安全不变量

- Category ACL 与 trust level 是 AND。
- 版主 scope 不能由 role alone 推导。
- pending 帖子仅作者本人和该板块 staff 可见；主题作者不能看到其他人的待审回复。
- author-downgrade 例外只绕过作者本人主题的等级，不绕过 Group ACL、删除状态或停权状态。
- 私密/公共媒体都不返回 R2 object key、bucket 地址或 Presigned GET。
- Public bucket 保持无公开域名。
- 日志不得包含 OTP、session、邀请 token、Passkey challenge、邮件正文、完整 Presigned URL、邮箱、IP 或原始 userId。错误日志只写 requestId/事件名/Error.name。
- Markdown 不允许 raw HTML；摘要、邮件和元数据必须使用纯文本。
- SQL 参数化；用户输入不能决定列名或原始 ORDER BY。
- 列表用 keyset cursor，不得引入深 OFFSET。

## 7. 已验证证据

2026-08-18 接手收束后的稳定结果：

- `npm run typecheck`：通过。
- `npm run lint`：通过。
- `npm test -- --reporter=dot`：32 files / 8,200 tests 全通过。
- Vite production build：通过。
- Wrangler deploy dry-run：通过。
- Fresh local D1 migration：`0001`（42 commands）与 `0002`（2 commands）依次成功。
- 真实 local D1 smoke：举报→审核决定→隐藏通知→已读；FTS 权限；点赞/收藏幂等；媒体 bind 与 ACL public→private reconciliation。
- 新增专项证据：图片客户端 11 tests；维护中央 guard 73 tests；邀请管理/消费 14 tests；Admin/维护/邀请界面完成桌面与 390px 移动端视觉 smoke。

下一位 AI 仍必须以自己重新运行的结果为准更新本节和 README，不得复制旧数字冒充当前结果。

## 8. 当前图片切片的完成标准

下列标准已在 2026-08-18 完成；后续改动不得使其退化：

- 最多 10 张；输入仅 JPEG/PNG/WebP，每张最多 12MB、24MP。
- Canvas/createImageBitmap 处理方向并剥离 EXIF/GPS。
- 主图最长边 2048、WebP 约 q0.82、硬上限 1.5MiB。
- 缩略图最长边 640、约 q0.74、硬上限 250KiB。
- 无 WebP 时回退 JPEG，超限时降低质量/尺寸或明确拒绝。
- Web Crypto SHA-256，标准 base64 checksum。
- authorize → 精确 signed headers 直传 R2 → finalize → 创建主题 → 按 `firstPostId` bind。
- Markdown 图片 URL 为 `/api/media/<uploadId>`。
- 主题创建前失败要 best-effort 删除临时 upload。
- 主题已创建但 bind 失败不得再次 POST 主题；必须保留重试绑定状态。
- object URL 全部 revoke；无图发帖不能退化。
- 最后运行 typecheck、client ESLint、Vite build 和全套 tests。

已知剩余协议风险：`POST /api/topics` 尚未接受按用户绑定的 `Idempotency-Key`。若 D1 已提交但响应丢失，客户端无法证明主题是否创建成功；不要仅靠前端布尔状态伪装为已解决。

## 9. 下一步顺序（不要并行扩张）

### P0：先让当前仓库诚实可部署

1. **已完成**：第 8 节图片切片、可恢复 bind job 与 PUT/cleanup 竞态修复。
2. **已完成**：`maintenance_mode` 中央服务端强制、统一 503、前端横幅/文案与 Admin 恢复入口。
3. **已完成**：最小 Admin 一次性邀请创建/列出/撤销 API、界面与注册消费测试。
4. 把 README Deploy Button 的 `OWNER/cforum` 和 `APP_ORIGIN` 占位配置改为实际仓库/域名后，才能称为“一键部署”。这需要仓库所有者信息，不能由 AI 猜测。
5. 用真实 Cloudflare 测试账户验证 Turnstile hostname、Resend 域名、Private R2 CORS 与 Presigned PUT；本地 dry-run 不能替代这一步。

### P1：按纵向切片继续

1. 恢复码、账号恢复、注销所有设备。
2. Admin Category/Group/ACL CRUD；再做用户查询、禁言/停权、session 撤销。
3. 邀请邮箱/域名限制、多次使用、过期时间和自动加组；基础创建/撤销审计已完成。
4. 主题/板块关注级别和对应回复/提及/点赞通知。
5. 用户资料与权限过滤后的发言历史、获赞和等级进度。
6. 草稿、编辑窗口、post revisions、软删除/恢复。
7. 固定徽章与授予/撤销历史。
8. 发主题/回复/搜索/举报的等级日限额、异常发帖 Turnstile 和敏感域名/链接策略。
9. Usage/容量仪表板与 Worker/D1/Queue/邮件阈值降级。

### Phase 4：上线验收

- 生成 30,000 用户/80,000 内容的合成数据。
- 对每个主要查询保存 `EXPLAIN QUERY PLAN` 与 rows-read 预算。
- 模拟 3,000 DAU 请求模型；不要声称真实并发。
- 做 D1 Time Travel/逻辑导出/R2 清单/恢复演练。
- 补隐私政策、社区规则、删除/导出与申诉流程。

## 10. 已知上线阻断与限制

- Deploy Button 与 `APP_ORIGIN` 仍是占位值。
- 用户资料、草稿、编辑历史、恢复码、徽章、完整关注通知、完整后台和用量仪表板未完成。
- 主题/回复/搜索尚未实现全部按等级可配置日限额；高风险发帖未接 Turnstile。
- 安装向导尚未完整引导邮件、Turnstile、R2 CORS/凭证和容量阈值。
- Public 媒体经过 Worker 的安全设计可能提高动态请求量；尚未做 3,000 DAU 媒体请求容量实测。
- heartbeat 可限频限幅，但不能证明用户真的持续注视页面。
- 处罚历史还没有独立结构化表，Lv3 sanction 判断兼容现有 moderation action 类型。
- `POST /api/topics` 尚无幂等键；服务端已创建但响应丢失时可能重复发帖。实现时应新增服务端持久 idempotency record，并保持用户/请求体绑定和过期清理。

## 11. 部署变量与运维注意

`.dev.vars.example` 只列变量名和开发占位，不得提交真实值。至少需要四个相互独立、长度不少于 32 字节的 HMAC/challenge secret，以及 bootstrap secret。

R2 直传只对 `PRIVATE_MEDIA` 配 CORS：精确 `AllowedOrigins`、`PUT`、`Content-Type` 和 `x-amz-checksum-sha256`。Public bucket 不配公开读。当前代码不再使用 `PUBLIC_MEDIA_BASE_URL`。

三个 Cron：

- `*/15 * * * *`：trust review。
- `7 * * * *`：media cleanup。
- `17 2 * * *`：session/OTP/rate-limit/challenge/reservation maintenance。

邮件 Queue 失败进入重试/DLQ；生产未配置 Resend 时公开邮件认证 fail closed，但 Passkey 登录不受影响。

## 12. 给下一位 AI 的最短提示词

> 读取 `docs/ai-handoff-next.md`、README 和其中列出的 ADR，先重跑完整基线。图片闭环、维护模式和最小一次性邀请管理已经完成，不要重复实现。保留工作区所有现有文件和用户改动，不使用 Discourse 源码或非 Cloudflare 服务。下一代码切片按 P1 顺序从恢复码/账号恢复开始；若先处理已知可靠性风险，则为 `POST /api/topics` 设计服务端持久幂等键。继续遵守等级 AND ACL、精确版主 scope、作者降级只读、统一 404、媒体继承主题权限和成熟安全库等不变量，并更新真实测试结果与未完成清单。
