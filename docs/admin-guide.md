# CForum 管理员手册（实施期版本）

## 首次安装

1. 部署 Worker 和资源绑定。
2. 设置所有 HMAC secret、bootstrap secret、`APP_ORIGIN`。
3. 打开站点，使用安装向导创建首位 Lv4 Admin。
4. 安装成功后轮换 `BOOTSTRAP_ADMIN_SECRET`；数据库唯一 bootstrap claim 会继续阻止重复安装。
5. 创建 Turnstile widget 与 Resend 发信域名；未完成前不要开放注册。
6. 为管理员账户设置至少一个 Passkey，并保存恢复码（恢复码流程完成后）。

## 注册模式

- `open`：邮箱验证后 active。
- `approval`：邮箱验证后 pending，进入注册审核队列。
- `invite_only`：必须使用有效邀请；`invite_requires_approval` 默认 false。

`registration_frozen=true` 会停止新注册验证码和注册提交。邮件服务不可用时生产验证码流程 fail closed，不影响已有 Passkey 登录。

Active Admin 可从顶栏“管理”进入邀请工作台：

- “生成新邀请”创建一枚只可成功注册一次的 token；原始邀请链接仅在创建响应和当前结果卡中出现一次，关闭后无法找回。
- 服务端只保存 `INVITE_HMAC_SECRET` 计算出的 HMAC，不在列表或审计中返回 token/hash。
- 管理页可按 keyset 查看状态并撤销未使用邀请；撤销为幂等操作。
- 当前 P0 界面不提供指定邮箱/域名、过期时间、多次使用或自动加组；这些字段不得通过手工改请求绕过严格 schema。
- 收到 `?invite=` 链接的用户会进入注册流程并预填 token；注册成功或进入审批后，token 会从地址栏移除。

Lv0 前若干主题与回复的审核数量分别由 `lv0_first_topics_review_count` 和 `lv0_first_replies_review_count` 控制；设为 `0` 表示关闭。板块自身的强制审核仍独立生效。

Active Admin 可通过 `GET /api/admin/settings` 查看基础设置，并以带会话 CSRF 请求头的 `PATCH /api/admin/settings` 在线调整注册模式、注册冻结、邀请制审批、维护模式及上述两个 Lv0 阈值。该接口使用固定字段白名单并写入 `audit_logs`；版主和非 active 管理员无权调用。当前管理页还提供板块创建、多管理员、成员等级与邀请管理；其余设置的完整图形化后台仍在后续阶段。

## 多管理员与成员等级

Active Admin 可在“成员与权限”中按用户名、昵称或邮箱搜索成员。对应接口为 `GET /api/admin/users`，使用 `q` 与 keyset `cursor`；修改使用带 CSRF 的 `PATCH /api/admin/users/:id`，请求可以只包含 `role`、`trustLevel`、`levelLocked` 中需要变化的字段。

- 把状态正常的成员角色设为 `admin` 后，该成员下一次请求便拥有完整 Admin 权限。系统没有高于 Admin 的超级管理员；Bootstrap 只负责建立第一位管理员，不形成永久“站主”特权。
- 角色与信任等级彼此独立。任命 Admin 不会自动把成员改为 Lv4；Active Admin 的全站管理能力来自角色，普通内容权限仍保留清晰的等级记录。
- 管理页不允许管理员更改自己的角色。要撤销某位管理员，请先由另一位 Active Admin 登录操作。
- 系统始终要求至少保留一名 `role=admin` 且 `status=active` 的账号。撤销最后一名有效管理员时 API 返回 `409 / LAST_ACTIVE_ADMIN_REQUIRED`；数据库 trigger 也会阻止其他代码路径停权、降级角色或删除最后一名有效管理员。任何非 active 的 Admin 都不计入该保护数量。
- 选择新的信任等级时，管理页会同时启用“保持手动等级”。即使调用 API 时只提交 `trustLevel`，服务端也默认设置 `level_locked=1`，避免定时复核立即覆盖人工决定。
- 取消“保持手动等级”后，Lv1–Lv3 成员会重新进入定时自动升降级队列；实际变化取决于活动指标与当前规则，不保证立刻改变。Lv4 按规则始终只允许手工授予，管理页不会把它显示为可自动复核。
- 人工等级变化会写入 `user_level_history`、站内通知和 `audit_logs`。降级仍会触发作者高等级主题的只读保护，不会绕过既有等级与 ACL 不变量。

角色设为 `moderator` 本身不会授予任何板块治理范围；仍必须存在精确的 `moderator_category_scopes`。当前管理页尚未提供 scope 分配界面。

## 开设板块

Active Admin 可在“板块管理”中创建顶层板块；对应接口为 `GET /api/admin/categories` 与带 CSRF 的 `POST /api/admin/categories`。

- `slug` 长度为 2–60，只允许小写英文、数字以及分隔单词的单个连字符，并且全站唯一。
- `aclMode=open` 表示 ACL 允许游客读取、登录账号发主题与回复；等级门槛仍会继续应用，因此阅读门槛高于 Lv0 时并不会真的向游客公开。
- `aclMode=restricted` 会自动写入 `authenticated` 的 `see`、`reply`、`create` 三项授权，形成仅登录成员板块；它不是自定义 Group ACL。
- `minCreateLevel`、`minReplyLevel` 与 `allowedTopicMinLevelMax` 都不能低于 `minViewLevel`。管理页在提高阅读门槛时会同步抬高这些冲突值，服务端仍会再次校验。
- `allowedTopicMinLevelMax` 限制成员在该板块创建主题时可选择的最高可见等级；`allowImages=false` 会禁止该板块的新主题使用图片上传。
- 创建使用 D1 batch 同步写入板块、必要 ACL 与 `category.create` 审计。重复 slug 返回 `409 / CATEGORY_SLUG_TAKEN`，不会留下半成品或审计记录。

当前管理页尚不支持修改、排序、归档或删除既有板块，也不支持 Group ACL 与子板块；开设前应确认名称、slug 和权限门槛。

## 主题置顶

Active Admin 打开主题详情后，可以使用“置顶主题”或“取消置顶”按钮调整首页综合信息流。对应接口为带会话 CSRF 请求头的 `PATCH /api/topics/:id/pin`，请求体必须显式提供 `desired: true` 或 `desired: false`。

- 置顶复用主题的 `pinned_at` 字段；非空时综合信息流优先展示该主题，取消后恢复按最近活动时间排序。操作不会修改主题正文、`bumped_at`、可见等级、板块 ACL 或锁定状态。
- 只有具备有效 session 且状态为 `active` 的 Admin 可以调用。Member、Moderator、非 active Admin 与无 session 请求均不能操作；全局 Origin 与 CSRF 校验仍先于业务写入生效。
- 只有已批准且状态为 `open`、`locked` 或 `archived` 的主题可调整。不存在、待审或已删除主题统一返回 404，不会产生审计记录。
- 接口按目标状态幂等：重复提交相同 `desired` 会返回当前状态及 `changed=false`，不会刷新 `pinned_at`、`updated_at` 或重复写审计。
- 实际置顶和取消置顶分别写入 `audit_logs` 的 `topic.pin` 与 `topic.unpin`，同时保存变更前后的 `pinned` 布尔状态、操作者、板块、请求 ID 与发生时间。
- 成功后主题详情会立即显示新状态并提示首页排序已更新；客户端同时刷新 Feed，使返回社区时无需手工重新载入。

## 只读维护

- 管理页的“开启只读维护”会立即写入 `maintenance_mode=true`；不使用 isolate 内存缓存，因此下一次请求即生效。
- GET、HEAD、OPTIONS、Bootstrap、登录恢复链及 logout 保持可用。普通成员、游客与 Moderator 的业务 mutation 由中央 middleware 统一拒绝为 `503 / SITE_MAINTENANCE`。
- 状态正常的 Admin 在读取维护设置前直接 bypass，仍可登录管理页、处理紧急写入并关闭维护。停权或无有效 session 的 Admin 不会 bypass。
- 已签发的 R2 Presigned PUT 无法撤回；维护期间 finalize/bind 会被阻止，超过 24 小时的临时对象由媒体清理 Cron 回收。
- 前端横幅与禁用提示仅用于体验，不能替代服务端 guard。

## 审核与举报

- 登录且状态为 active 的成员可用 `POST /api/posts/:id/reports` 举报自己有权查看的已发布帖子。同一成员、帖子和举报类型只产生一份 `reports` 记录及一项审核任务；网络重试不会重复入队。
- Active Admin 和 Active Moderator 使用 `GET /api/admin/review` 查看审核队列。Admin 可查看全站及注册审核；Moderator 只会收到 `moderator_category_scopes` 明确列出的板块项目，越权项目与不存在项目统一返回 404。
- `POST /api/admin/review/:id/decision` 接受 `approve` 或 `reject`。同一结果可安全重试；相反结果或已经取消的项目返回冲突，不会覆盖原处理人。
- 处理动作在一个 D1 batch 内同步写入审核项、目标账号/主题/帖子、举报状态、`moderation_actions`、站内通知和 `audit_logs`。批准注册后会使用 Queue 异步发送结果邮件；邮件失败不回滚已经提交的审核决定。
- 接受举报会隐藏目标帖子；若目标是首帖，则同时删除主题。驳回举报不会修改内容。批准待审首帖/回复会重新精确计算主题回复数与参与人数，避免计数漂移。

通知读取使用 `GET /api/notifications`，标记已读使用 `POST /api/notifications/read`。通知返回前会重新应用当前主题权限；内容已隐藏或成员已经失权时，只保留通用事件提示，目标链接和内容字段会被移除。

## 版主授权

版主必须逐板块写入 `moderator_category_scopes`，不自动继承子板块；只把成员角色改成 `moderator` 不会自动产生 scope。当前管理页尚未提供 scope 分配。授权后仍应确认其只能处理该板块内容、附件、举报与审核项；注册、角色、等级、全站处罚、ACL 和站点设置仅 Admin 操作。

## 媒体与生命周期

- Public bucket：只保存真正 Guest 可见内容的不可变变体，但仍只能通过 Worker 的 `/api/media/*` 读取；不要绑定公开自定义域名，也不要启用 `r2.dev`。
- Private bucket：保存临时、受限和隔离内容。只为浏览器直传的 Presigned PUT 配置精确站点来源、PUT/HEAD 与必要请求头的 CORS，不允许公开读。
- 每小时 Cron 会以固定批次清理超过 24 小时的临时对象、已删除媒体和孤儿对象；单次最多连续处理四页，失败会让 Cron 明确失败以便 Cloudflare 重试。不要手工删除 `_internal.media_cleanup.*` 游标设置。
- 审核批准和权限调整后会重新计算 Public/Private 分级；即使搬运重试尚未完成，读取路径也会按最新主题 ACL fail closed。
- R2 7GB 告警、8GB 硬停上传；不要手工提高硬限制而不评估账单。

## 每日检查

- Worker 请求、错误率与 CPU。
- D1 rows read/write 和数据库大小。
- R2 字节数/Class A/Class B。
- Queue 重试与 DLQ。
- Resend 当日发送数与失败。
- 新增审核、举报、停权与高权限操作审计。

日志中不得出现 OTP、session、邀请 token、Passkey challenge、邮件正文或完整 Presigned URL。

## 上线前站主决策

上线前必须填写社区规则、隐私政策、服务条款、违法/侵权入口和管理员联系方式，并明确未成年人政策、安全日志保留、封禁申诉时限以及用户数据导出/删除流程。
