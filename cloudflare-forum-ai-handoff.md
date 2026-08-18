# Cloudflare 原生论坛：交给下一位 AI 的完整实施任务书

> 将本文件整段交给另一个具备代码与终端能力的 AI。它是产品需求、技术方案和验收标准的共同基线，不是仅供讨论的概念稿。

## 0. 给执行 AI 的工作指令

你现在要在当前工作区中设计并实现一个参考 Discourse 核心理念、但专为 Cloudflare 免费额度优化的中文论坛。此任务最终要交付可运行代码，而不只是继续写方案。

开始时请：

1. 检查工作区、现有代码、`AGENTS.md`、技能及依赖；如果工作区为空，则从零建立项目。
2. 建立并持续更新实施计划，然后立即开始第 0、1 阶段；不要只复述需求。
3. 优先保证权限不泄漏、可部署、可迁移、可测试，再扩展界面效果。
4. 所有重大假设写入 README 或 ADR；所有数据库变更使用版本化 migration。
5. 每完成一阶段都运行单元、集成、类型、构建和必要的安全测试。
6. 不得以“首版简化”为理由破坏下面的权限、安全、注册模式、等级主题和图片访问约束。P0/P1/P2 只代表实施先后，不代表取消功能。

## 1. 项目目标

构建一个不依赖 VPS、Docker、PHP、MySQL 或常驻服务器的论坛：

- 前端、API、数据库、文件、队列和防机器人均运行在 Cloudflare。
- 新用户可以通过 Cloudflare 的 Deploy 按钮安装；D1、R2 和 Queue 自动创建及绑定。
- 使用 `*.workers.dev` 即可运行；正式环境推荐绑定自有域名。
- 在 Cloudflare Free 范围内把固定主机成本控制为 0；R2 是按量计费产品，因此应用必须设置容量硬闸门，不能承诺绝不会产生超额账单。
- 参考 Discourse 的信任等级、主题流、板块权限、通知、审核队列和安全上传，但不复制其 Ruby 服务端、插件系统或全部复杂功能。
- 中文优先，桌面和移动端都可用，界面可以借鉴 Discourse 的信息结构，但不要做像素级复刻。

## 2. 免费版正式设计规模

### 2.1 对外设计目标

- 3,000 DAU（日活用户）。
- 约 50,000 注册用户；单库首版推荐验收数据为 30,000 用户。
- 约 80,000 条主题首帖和回复；单库可规划范围约 60,000–100,000 条。
- 约 15,000–18,000 张长期压缩帖子图片。
- 默认不永久保留设备原图。
- 正常用户平均每天约 20 个动态 Worker 请求。

这不是 Cloudflare 的官方容量承诺，而是按免费额度、索引良好的查询和合并 API 计算的工程目标。

### 2.2 关键硬额度

| 资源 | Free 额度/限制 | 设计要求 |
|---|---:|---|
| Worker 动态请求 | 100,000 次/日 | 静态资源不得进入 Worker；为机器人、后台和重试预留 20,000 次 |
| Worker CPU | 每次 10ms | 不在服务端做重型图片转码或复杂 SSR |
| 静态资源请求 | 免费且不限请求量 | SPA 外壳、JS、CSS、图标使用 Workers Static Assets |
| D1 读取 | 500 万行/日 | 所有列表使用索引和游标分页；检查 `rows_read` |
| D1 写入 | 10 万行/日 | 不要每次浏览都写在线状态、精确浏览量或等级 |
| D1 单数据库 | 500MB | 300MB 预警，350MB 准备升级，400MB 停止非必要增长 |
| D1 账户总量 | 5GB/最多10库 | 首版保持单库，抽象存储接口并预留 `content_shard_id`，不要首版真正分片 |
| R2 Standard | 10GB-month/月 | 应用软上限 7GB、硬上限 8GB，保留至少 2GB 计费余量 |
| R2 操作 | 100万 Class A、1000万 Class B/月 | 图片使用直传、公开缓存和批量签名 |
| Turnstile | 免费、20个组件、验证次数不限 | 注册、验证码发送和高风险发帖使用 |
| Queue Free | 10,000 operations/日 | 一封邮件通常约3次操作；用于异步邮件和重试 |

### 2.3 容量计算基线

```text
DAU ≈ (100,000 - 20,000预留请求) / 20动态请求
    ≈ 4,000数学容量
```

对外只承诺 3,000 DAU，以保留突发空间。高频浏览（约30动态请求/DAU）时约为 2,600 DAU。

正常索引情况下，假设每次 API 平均读取30行：

```text
3,000 DAU × 20 API × 30行 ≈ 180万行/日
```

因此正常情况下 Worker 每日请求会先于 D1 行读取成为瓶颈；一条未索引扫描却可能迅速耗尽 D1，所以所有主要查询必须用 `EXPLAIN QUERY PLAN` 验证。

## 3. 技术架构

### 3.1 推荐栈

- TypeScript。
- React + Vite SPA，使用 Workers Static Assets。
- Hono 或同等轻量 Worker Router，仅处理 `/api/*`、必要的私密媒体及安装向导。
- Cloudflare D1（SQLite 语义）保存业务数据。
- D1 FTS5 保存标题和正文搜索索引。
- 两个 R2 bucket：公开媒体和私密媒体/临时上传。
- Cloudflare Queues 处理邮件发送、重试和非阻塞任务。
- Cloudflare Turnstile 防机器人。
- WebAuthn/Passkey 为主要登录方式，邮箱 OTP 为注册、恢复和备用登录方式。
- Cloudflare Web Analytics 作为基础访问统计。

Cloudflare 已明确建议新项目使用 Workers Static Assets，而不是再从 Pages 起步。静态路由必须直接命中资源，不能先经过 Worker。

### 3.2 运行拓扑

```text
浏览器
  ├─ HTML/JS/CSS ───────────> Workers Static Assets
  ├─ 论坛 API ───────────────> Worker ──> D1
  ├─ 邮件任务 ───────────────> Worker ──> Queue ──> Email Provider
  ├─ 公开图片 ───────────────> media.example.com / Public R2
  └─ 等级限制图片 ───────────> 短期 Presigned GET URL / Private R2
```

### 3.3 部署目标

仓库必须包含：

- `wrangler.jsonc` 或等价配置，声明 D1、Public R2、Private R2、Queue、静态资源和必要变量。
- `package.json` 中的 `build`、`test`、`db:migrate`、`deploy` 脚本。
- 部署脚本先执行远端 D1 migrations，再部署 Worker。
- README 中的 Deploy to Cloudflare 按钮。
- `.dev.vars.example`，只放变量名，不放真实密钥。
- 首次运行安装向导：设置站名、管理员、注册模式、Turnstile、邮件服务、媒体域名和容量阈值。
- 未配置邮件服务时，公开注册必须 fail closed；管理员仍可通过一次性 bootstrap secret 完成初始安装。

Deploy 按钮可以自动配置 Cloudflare 资源，但 Resend API Key、Turnstile 密钥、R2 S3 签名凭证、自定义域名等仍需安装向导明确提示用户填写。

## 4. 参考 Discourse 的功能原则

要借鉴的不是 Discourse 的技术栈，而是以下机制：

1. **Trust Levels**：Lv0–Lv4，等级来自可信参与，不是单纯灌水积分。
2. **Category ACL**：板块区分 See、Reply、Create，并支持用户组。
3. **Topic Lists**：Latest、New、Unread、Top/Hot，以及返回上次阅读位置。
4. **Notification Levels**：Watching、Tracking、Watching First Post、Normal、Muted。
5. **Moderation Review Queue**：注册、首帖、媒体帖、举报统一进入可审计队列。
6. **Client-side Image Optimization**：上传前在浏览器缩放、压缩、去 EXIF 并生成多尺寸。
7. **Secure Uploads**：附件继承主题权限，私密附件只给短期访问地址。
8. **社区工具**：点赞、收藏、引用、@提及、草稿、编辑历史、徽章、置顶、锁定、移动和慢速模式。

本项目在 Discourse 的板块 ACL 之上增加主题级 `min_view_level`，这是核心自定义功能。

首版不要照搬：实时聊天、邮件列表模式、邮件回复发帖、插件生态、任意 SQL 徽章、自学习举报权重、重型服务端图片转换、视频/音频托管、黑盒推荐算法。

## 5. 完整功能范围

### 5.1 注册、账号与会话

后台提供一个互斥设置：

```text
registration_mode = open | approval | invite_only
```

- `open`：邮箱验证成功后直接启用账号。
- `approval`：邮箱验证成功后进入待审核状态；管理员/版主批准或拒绝。
- `invite_only`：必须提交有效邀请令牌并完成邮箱验证；是否还需人工审核由独立、明确命名的设置控制，默认不再审核。
- 模式可在后台切换，无需重新部署。
- Turnstile 应用于验证码发送、注册提交和异常登录。
- 支持禁用邮箱域名、邮箱/IP/设备摘要限速、冻结注册、维护模式。
- 会话使用 Secure、HttpOnly、SameSite Cookie；服务端保存可吊销的会话哈希。
- 支持 Passkey 注册/登录、邮箱 OTP 备用登录、一次性恢复码、注销所有设备。
- 不要在 Worker Free 上引入高成本或参数过低的密码哈希；默认做无密码认证。如果以后必须支持密码，单独设计经过审计的 KDF 方案或接入专用身份服务。

邀请系统必须支持：

- 单邮箱邀请、限定邮箱域名、多次使用链接。
- `max_uses`、`used_count`、过期时间、撤销、创建人和使用审计。
- 邀请令牌数据库只保存哈希。
- 可配置最低邀请等级和每周邀请额度。
- 可选注册后自动加入用户组、跳转指定主题。

### 5.2 成员等级制度

等级与管理角色必须分离：

- `trust_level`：Lv0–Lv4，决定访问、速率和社区权限。
- `role`：member、moderator、admin，决定治理权限。
- `groups`：由管理员管理，用于特殊板块 ACL。
- 徽章只用于荣誉展示，不得隐式解锁受限内容。

默认等级规则如下，所有阈值均可在后台修改：

| 等级 | 晋级默认条件 | 降级规则 | 主要能力 |
|---|---|---|---|
| Lv0 新人 | 邮箱已验证，默认等级 | 不适用 | 严格限速；前3个主题/回复可进入审核；有限图片上传 |
| Lv1 基础 | 进入5个主题、阅读30帖、阅读10分钟 | 不因不活跃下降 | 正常点赞、收藏、举报、发帖和回复，仍受板块规则限制 |
| Lv2 成员 | 进入20主题、阅读100帖、阅读60分钟、访问15天、回复3个不同主题、至少给出和收到1个赞 | 默认连续90天无“阅读至少1帖或有效发言”才降至Lv1；降级前提前14天提醒 | 更高限额、邀请配额、可发布最高Lv2可见主题 |
| Lv3 常客 | 最近100天滚动满足：阅读/访问/跨主题回复/点赞/低违规等组合条件 | 低于晋级要求约90%持续触发降级；首次晋升有14天保护期，降至Lv2 | 可发布Lv3主题、更高邀请与举报额度、部分社区整理权限 |
| Lv4 领袖 | 只能由管理员手动授予 | 只能手动撤销 | 可配置社区协助能力，但不自动等于版主 |

Lv3 默认条件参考 Discourse：最近100天读过至少25%的新主题（上限500）、25%的新帖（上限20,000）、回复10个不同主题、在至少50天有阅读、给出30赞、收到20赞且来自至少5个用户并分布在7天以上；被确认的严重举报不超过阈值，近6个月没有禁言/停权。小社区可在后台降低阈值。

实现要求：

- 升级条件是 AND 组合，不是任意满足一项。
- 自己主题里重复回复、短时间刷阅读、同一批账号互赞要被限流或去重。
- 使用 `user_activity_daily` 和滚动汇总，不在每天全表重写所有用户等级。
- 保存 `next_level_review_at`、`level_locked` 和完整 `user_level_history`。
- 一个定时任务小批量处理到期用户；登录或关键操作时也可惰性复核。
- 任何自动或手动升降级都产生站内通知和审计记录。
- 用户可查看自己的升级进度、缺少条件和可能降级日期。

建议默认操作限额（必须后台可配置）：

| 能力 | Lv0 | Lv1 | Lv2 | Lv3+ |
|---|---:|---:|---:|---:|
| 新主题/日 | 3 | 5 | 10 | 20 |
| 回复/日 | 10 | 30 | 60 | 100 |
| 压缩媒体/日 | 5MB | 15MB | 30MB | 50MB |
| 邀请/周 | 0 | 0 | 2 | 10 |

### 5.3 板块、用户组和等级主题

每个板块至少配置：

```text
min_view_level
min_create_level
min_reply_level
allowed_topic_min_level_max
group_acl (see/reply/create)
require_topic_approval
require_reply_approval
allow_images
```

每个主题至少配置：

```text
category_id
author_id
min_view_level
effective_min_view_level
status
```

规则：

- `effective_min_view_level = max(category.min_view_level, topic.min_view_level)`。
- 作者只能选择不高于自己当前等级、且不超过板块允许范围的主题可见等级。
- 例如 Lv3 用户在“开发”板块发布 `min_view_level=3` 的主题，该主题会进入 Lv3/Lv4 用户主页、板块和搜索；Lv0–Lv2 及游客完全看不到标题、摘要、作者、计数或图片。
- 无权限访问时统一表现为 404，避免通过403或ID枚举确认内容存在。
- 作者后来降级时，仍可查看自己创建的主题和自己的附件；如果已低于板块回复等级，则不能继续回复其他受限内容。主题本身的等级不自动改变。
- 其他已参与用户降级后按当前等级失去访问；历史内容不删除。
- 管理员/版主是否绕过权限必须由明确策略决定并写测试，默认管理员可访问全部，版主只访问被授权板块。

必须建立统一权限服务：

```text
canViewCategory(context, category)
canCreateTopic(context, category, requestedMinLevel)
canViewTopic(context, topic)
canReplyTopic(context, topic)
canModerate(context, target)
canAccessUpload(context, upload)
```

禁止在不同接口重复拼凑权限逻辑。

权限过滤必须覆盖：

- 主页所有信息流。
- 板块列表、主题详情和相邻主题。
- 搜索、搜索联想、标签和用户发言历史。
- 未读数量、全站/板块计数和热门排行。
- 通知、收藏、书签和关注列表。
- RSS、站点地图、SEO、Open Graph 和链接预览。
- 图片、缩略图、附件及其缓存键。
- 管理后台之外的所有 API。

### 5.4 主页与信息流

主页必须是可作为日常入口的信息流，至少提供：

- **综合**：站务置顶＋最新活动；早期社区默认使用此项。
- **最新**：按 `bumped_at DESC, id DESC` 排列。
- **热门**：点赞、不同回复者、回复数量及时间衰减组成的预计算分数。
- **关注**：用户关注的板块和主题。
- **未读/新内容**：用户未看过的主题，以及已看主题的新回复。
- 板块、标签和等级范围筛选。

热门分数可从类似公式起步，并允许后台调参：

```text
hot_score = ln(1 + 3*unique_repliers + 2*likes + replies) - age_hours/48
```

- 权限过滤必须先于排序。
- 使用 keyset/cursor pagination，禁止随数据增长而昂贵的深 `OFFSET`。
- 热门分数由 Cron/事件增量更新，不能每次首页实时扫描帖子。
- 首页卡片显示板块、标题、纯文本摘要、作者、标签、回复/点赞数、最新活动和符合权限的缩略图。
- 记录每个用户的主题阅读位置，点击后跳到上次阅读处。
- 合并 API 响应，目标是普通用户每天约20次动态调用，不要为卡片每个字段单独请求。
- 首版不做机器学习或短视频式黑盒推荐。

### 5.5 主题、回复和互动

必须包含：

- 发布主题、回复、引用回复、@提及。
- Markdown、代码块、链接和安全预览；默认禁用原始 HTML。
- 草稿自动保存和恢复。
- 编辑窗口、编辑历史、软删除和管理员恢复。
- 点赞/表态、收藏/书签。
- 标签。
- 主题关注级别：watch、track、watch_first_post、normal、mute。
- 置顶、加精、锁定、归档、移动板块。
- 慢速模式可作为 P1；主题拆分/合并可作为 P2。
- 用户资料页、发言历史、获赞、徽章和等级进度；所有历史内容仍需权限过滤。
- 深色模式、响应式布局、键盘可访问性和基础无障碍语义。

正文只保存 Markdown 源文；避免为所有内容永久保存一份大体积 HTML。前端解析时必须关闭原始 HTML，并使用严格 sanitizer。用于摘要、邮件和元数据的内容必须转为转义后的纯文本，不能复用未经处理的 Markdown。

### 5.6 搜索

- 使用 D1 FTS5 对主题标题和帖子正文建立全文索引。
- 搜索结果在返回前必须经过板块、用户组和主题等级过滤。
- 未授权主题的词语不能出现在联想词、结果数量或摘要中。
- 对短词、超长查询、通配符和高频重复搜索限流。
- 搜索失败或接近 D1 行读取阈值时，允许降级为标题前缀或临时关闭全文搜索。

### 5.7 通知

站内通知至少包括：

- 回复、引用、@提及。
- 点赞。
- 关注主题/板块的新内容。
- 主题被置顶、锁定、隐藏、移动或恢复。
- 举报结果和审核结果。
- 等级升级、降级预警和实际降级。
- 邀请被使用。
- 注册批准、拒绝或需要补充资料。

通知创建时和读取时都重新检查访问权；等级下降或板块权限变更后，旧通知不能泄漏标题、摘要或图片。已读通知保留期建议180天，过期后批量清理以保护 D1 空间。

### 5.8 徽章

首版实现 8–12 个固定徽章：首帖、首个获赞、连续访问、热心回复、优质贡献、有效邀请、获得50赞、社区元老等。

- 支持自动授予、手动授予、撤销、授予原因和关联帖子。
- 徽章和 `trust_level` 完全分离。
- 首版不允许管理员编写任意 SQL 徽章规则。

### 5.9 举报、审核和管理后台

统一审核队列至少包含：

```text
registration
first_post
media_post
report
```

每个审核项记录：触发原因、内容快照、提交人、目标用户、状态、优先级、处理人、动作、内部备注、创建/处理时间和不可变审计时间线。

举报类型：跑题、不当、垃圾、违法、其他。支持：同意并隐藏、同意但保留、编辑、删除、恢复、警告、禁言、停权、驳回。首版可以用透明规则（例如3名符合条件的不同用户举报）自动隐藏，之后人工复核；不要首版实现自学习权重。

管理后台还要包含：

- 站点信息、注册模式和维护模式。
- 板块、标签、用户组和权限。
- 等级阈值、限额和手动等级锁定。
- 用户查询、封禁、禁言、会话撤销和审核历史。
- 邀请创建、撤销、使用记录。
- 敏感词、禁用域名和链接策略。
- 内容、媒体、邮件、D1/R2/Worker 使用量仪表板。
- 容量预警和自动关闭图片上传开关。
- 管理操作审计日志。

## 6. 邮箱验证码实现方案

### 6.1 免费版邮件提供商

Cloudflare Email Sending 向任意收件人发信需要 Workers Paid；Free 只能做 Email Routing 或向已验证目的地址发送，不能满足公开注册。

免费版默认接入 Resend：当前 Free 为 3,000 封/月、100封/日、1个自定义发信域名，并有官方 Cloudflare Workers 集成。生产发送需要用户拥有并验证域名。

实现一个提供商抽象：

```text
interface EmailProvider {
  sendVerification(...)
  sendRegistrationDecision(...)
  sendSecurityAlert(...)
}
```

实现：

- `ResendEmailProvider`：免费版默认。
- `CloudflareEmailProvider`：升级 Workers Paid 后可切换；当前含3,000封/月。
- `DisabledEmailProvider`：仅供本地开发；生产公开注册必须拒绝启动或关闭注册。

### 6.2 OTP 安全流程

1. `POST /api/auth/email/request-code` 接收规范化邮箱和 Turnstile token。
2. 始终返回一致的通用响应，避免判断邮箱是否已注册。
3. 使用 Web Crypto 生成6位或8位随机码和独立 challenge ID。
4. D1 只保存 `HMAC(server_secret, challenge_id + email + code)`，不保存明文验证码。
5. 验证码默认10分钟失效、最多5次尝试、成功后一次性消费。
6. 重发间隔至少60秒；同邮箱每小时最多5次、每日最多10次；同IP/设备摘要每日设更高但有限的阈值。
7. 新验证码使旧验证码失效。
8. 把邮件任务写入 Queue；消费者使用指数退避和 idempotency key 调用邮件提供商。
9. 发送失败不能创建已验证账号；后台应看到失败原因和可重试状态。
10. 邮箱变更、账号恢复和高风险安全操作重新验证。

Resend 100封/日是免费版注册突发的真实瓶颈。达到80封/日时后台预警；达到额度时自动暂停新的自由注册请求，但不能影响已有用户用 Passkey 登录。

## 7. 图片上传、压缩和原图方案

### 7.1 R2 容量分配

R2 免费 10GB-month，但应用内部按以下方式控制：

- 0.5GB：头像、站点图和系统图片。
- 0.5GB：待确认上传、孤儿文件和短期原图。
- 7GB：长期帖子图片。
- 2GB：计费安全余量，应用不主动使用。

### 7.2 客户端处理规格

原始选择文件建议硬限制为12MB、24MP；Cloudflare 虽允许更大的请求体，产品不应照搬平台上限。

浏览器在上传前：

- 修正 EXIF 方向并去除 EXIF/GPS。
- 主展示图：最长边1920或2048px，WebP quality 0.80–0.84，平均约320KB，硬上限1.2–1.5MB。
- 信息流缩略图：最长边640px，WebP quality 0.70–0.76，平均约60KB，硬上限200–250KB。
- 头像：256px，目标20–30KB。
- 不支持 WebP 编码时回退 JPEG。
- 首版接受 JPEG、PNG、WebP；GIF 可暂不支持或仅取静态首帧；禁止 SVG、HTML、可执行文件和任意附件。
- 客户端声明不可信；完成上传后仍校验真实 magic bytes、MIME、尺寸、字节数和归属。

按320KB主图＋60KB缩略图计算：

```text
7GB / 380KB ≈ 18,400张
```

正式对外写为 15,000–18,000 张长期图片。若每天新增50张，7GB图片池约1年用完；因此必须有等级配额、单帖张数、每日字节额度和全站硬闸门。

### 7.3 原图策略

- 默认：原图只在用户浏览器本地解码；上传压缩后的主图和缩略图，R2 不永久保存设备原图。
- 可选：为私有原图池分配最多1GB，使用 R2 lifecycle 在7天后自动删除，作为纠错窗口。
- 平均原图3MB时，永久保留原图会把容量从约18,000张降至约2,000张，因此不能默认开启。
- 管理员或高等级用户可对个别原图申请长期保留，但必须占用单独配额并在后台可见。
- `tmp/` 未完成上传24小时后清理；回收站媒体最多保留7天。

### 7.4 上传流程

生产方案采用短期 Presigned URL 直传：

1. 浏览器压缩并生成主图和缩略图。
2. 请求上传许可；Worker 检查登录、等级、当日用户额度和全站剩余容量。
3. Worker 预留容量并为整批对象生成短期 Presigned PUT URL。
4. 浏览器直接上传到 Private R2 的 `tmp/` 前缀，不让大文件穿过 Worker。
5. 浏览器调用 finalize；Worker HEAD 对象并验证大小、MIME、文件头、尺寸和哈希。
6. D1 创建 `uploads`/`upload_variants` 记录，只有验证完成且属于当前用户的对象才能绑定帖子。
7. 发布公共主题时，将对象复制到 Public R2 的不可变随机键；发布受限主题时保留在 Private R2。
8. 失败或未绑定对象由生命周期/清理任务删除。

Presigned URL 需要 R2 S3 凭证；它们必须作为 Worker secret 保存。开发期可实现小文件 Worker 流式上传作为 fallback，但不能把它当作3,000 DAU的正式架构。

### 7.5 公开图片和等级限制图片

- 公共帖子图片：通过 Public R2 自定义域名（例如 `media.example.com`）和长缓存提供，不经过 Worker。`r2.dev` 只用于开发测试。
- 受限帖子图片：保存在 Private R2；主题 API 完成权限检查后，批量生成5–10分钟有效的 Presigned GET URL，浏览器直接取图。
- Presigned URL 是短期 bearer token，被转发后在过期前仍可使用；无法防止截图或短时分享，界面和隐私说明要如实表达。
- 不得把 Lv3 等受限图片放入公开 bucket，也不得仅靠难猜文件名保护。
- 媒体记录继承 `topic_id`、`post_id`、`owner_user_id` 和 `min_view_level`。
- 公共内容一旦被访问，其图片链接可能已被缓存或保存。因此把公共主题改成更严格权限时：默认阻止操作；只有无公开附件时才能直接修改。管理员强制迁移时必须生成新私有键、更新引用并明确警告旧公开链接无法保证撤回。

## 8. 数据模型方向

至少规划以下表或等价结构：

```text
users
user_emails
user_credentials
passkeys
sessions
recovery_codes
email_verifications
registration_requests
invites
groups
group_members
trust_level_rules
user_activity_daily
user_activity_rollups
user_level_history
categories
category_permissions
topics
posts
post_revisions
tags
topic_tags
reactions
bookmarks
topic_reads
topic_follows
category_follows
notifications
badges
user_badges
uploads
upload_variants
upload_reservations
reports
review_items
moderation_actions
site_settings
usage_counters
audit_logs
```

关键字段：

- `users`: `trust_level`、`role`、`status`、`level_locked`、`next_level_review_at`。
- `categories`: 三种最低等级、ACL、审核和媒体设置。
- `topics`: `min_view_level`、`effective_min_view_level`、`bumped_at`、`hot_score`、置顶/锁定/删除状态。
- `posts`: `topic_id`、楼层号、Markdown、作者、编辑和软删除状态。
- `uploads`: 所属主题/帖子、所有者、可见等级、公开/私有范围、哈希、MIME、尺寸、字节数和生命周期状态。
- `review_items`: 类型、内容快照、触发原因、状态、优先级和处理者。

数据库原则：

- 主键、时间和游标使用稳定排序；分页采用 `(bumped_at, id)` 等复合游标。
- 给权限过滤与排序建立复合索引，例如 `topics(effective_min_view_level, bumped_at DESC, id DESC)`，并按真实查询验证。
- D1 索引也占存储并增加写入，禁止“给每列都加索引”。
- 不保存每次页面浏览事件；阅读状态做合并 upsert 或批量提交。
- 浏览量使用近似/批量统计，不能每次打开都写主题行。
- 已读通知、过期会话、OTP、临时上传、无必要的编辑历史按保留策略清理。
- 从第一版保留 `content_shard_id` 和 repository abstraction，但免费首版不要真正跨10库分片。

## 9. API 方向

建议最少包括：

```text
POST /api/auth/email/request-code
POST /api/auth/email/verify
POST /api/auth/register
POST /api/auth/passkeys/options
POST /api/auth/passkeys/verify
POST /api/auth/logout
GET  /api/feed?tab=&cursor=&category=&tag=
GET  /api/categories
POST /api/topics
GET  /api/topics/:id
POST /api/topics/:id/replies
PATCH /api/topics/:id
POST /api/posts/:id/reactions
POST /api/posts/:id/bookmark
POST /api/posts/:id/report
GET  /api/search?q=&cursor=
GET  /api/notifications
POST /api/notifications/read
POST /api/uploads/authorize
POST /api/uploads/finalize
DELETE /api/uploads/:id
GET/POST/PATCH /api/admin/categories/*
GET/POST/PATCH /api/admin/users/*
GET/POST/PATCH /api/admin/invites/*
GET/POST/PATCH /api/admin/review/*
GET/PATCH /api/admin/settings/*
GET /api/admin/usage
```

每个 API 应定义：鉴权、权限条件、限速、输入 schema、幂等性、返回错误、审计要求和预期 `rows_read/rows_written` 预算。

## 10. 安全要求

- Turnstile token 必须服务端验证。
- 参数化 SQL，严格输入 schema，禁止动态拼接列名/排序字段。
- CSRF、防重放、CSP、HSTS、Secure/HttpOnly/SameSite Cookie。
- Markdown 禁用原生 HTML，并用 sanitizer 二次处理。
- 私有资源和普通 API 防对象级越权（IDOR）。
- OTP、邀请、恢复码、会话和上传许可只保存哈希或不可逆摘要。
- 邀请和 OTP 接口使用统一响应，防账户枚举。
- 上传校验 magic bytes、尺寸炸弹、扩展名伪造和文件名注入；禁止 SVG。
- IP 只保存短期、加盐摘要，避免长期保存完整 IP，除非明确合规需要。
- 管理员、版主和高等级用户的权限变化全部审计。
- 删除采用软删除＋有限恢复窗口；导出与隐私删除流程写入文档。
- 缓存键必须包含权限边界；禁止把个性化或受限响应放入公共缓存。

## 11. 备份、可迁移性与运营治理

- D1 Free 提供7天 Time Travel，应作为误删和错误 migration 的第一恢复手段；它不是离线或跨账户备份。
- 提供管理员可执行的逻辑导出脚本，至少导出 D1 schema、业务表、站点设置、R2 对象清单和文件哈希。建议每周导出一次，并保留一份在 Cloudflare 账户之外；不得把“备份也只放同一账户”描述为完整灾难恢复。
- 提供明确的恢复脚本和 runbook：新建 D1、执行 schema、导入数据、核对行数与哈希、重新绑定 R2、验证权限和搜索索引。上线前至少演练一次。
- 重大 migration 前记录 Time Travel bookmark 或等价恢复点，并阻止在没有恢复路径时继续。
- 帖子、用户和媒体应有稳定导出格式，避免平台锁定；用户个人数据导出与删除流程应写入管理员手册。
- R2 对象采用不可变随机键；数据库保存哈希与元数据。软删除媒体进入有限回收窗口，过期后再由 lifecycle 永久删除。
- 制定社区规则、隐私政策、服务条款、违法/侵权举报入口和管理员联系信息。是否允许未成年人、保留哪些安全日志、封禁申诉多久处理，需要由站主在上线前明确。
- 可观测日志不得包含 OTP、会话、邀请 token、Passkey challenge、完整 Presigned URL、邮件正文或不必要的个人信息。

## 12. 免费额度保护与降级

后台必须显示 Worker、D1、R2、Queue、邮件和上传使用量，并实现以下阈值：

- Worker 达到 70,000 次/日：预警并降低自动刷新/轮询。
- D1 读取达到 350万行/日：预警；接近上限时暂停热门重算和高成本全文搜索，保留最新列表与发帖。
- D1 数据库达到 300MB：预警；350MB 要求制定升级/迁移计划；400MB 阻止非必要数据增长。
- R2 达到 7GB：预警并降低个人上传额度；达到8GB自动关闭新上传，但已有图片继续可读。
- Resend 达到80封/日：预警；达到100封暂停新的验证码请求。
- Queue 失败进入可查看的失败记录或 DLQ；不得静默丢邮件。

Workers/D1 Free 达到日额度会返回错误，UTC 00:00 重置；台北时间为早上08:00。R2 超额可能计费，因此应用层8GB闸门是必须项而不是建议项。

达到以下任一条件的70%时开始评估 Workers Paid：2,500 DAU、70,000动态请求/日、D1 300MB、R2 7GB、邮件80封/日。不要为利用 Free 的5GB总量而过早做复杂分片；优先升级 D1 单库容量。

## 13. 实施阶段

### Phase 0：基础设施与安全骨架

- 项目脚手架、Workers Static Assets、Worker API。
- D1 migrations、repository 层和本地测试数据库。
- 中央权限服务及完整权限矩阵测试。
- 站点设置、bootstrap admin、健康检查。
- Wrangler/Deploy Button 基础配置。

### Phase 1：可用论坛核心

- 邮箱 OTP、Passkey、三种注册模式、会话。
- 板块/用户组、主题/回复、Markdown。
- 主页综合/最新、游标分页。
- 搜索、点赞、收藏、用户资料。
- 基础后台、Turnstile 和限速。

### Phase 2：Discourse 式社区机制

- Lv0–Lv4 计算、降级、进度和历史。
- 主题级 `min_view_level` 及全链路防泄漏。
- 未读/关注/热门信息流。
- 通知级别、站内通知、草稿、编辑历史、标签、徽章。
- 审核队列、举报、封禁、审计。

### Phase 3：媒体系统

- 浏览器压缩、EXIF 清除、主图/缩略图。
- R2 直传、finalize 校验、容量预留、孤儿回收。
- Public/Private R2 分流。
- 受限图片 Presigned GET。
- 原图7天可选保留及生命周期。

### Phase 4：上线与容量验证

- 使用合成数据验证 30,000 用户、80,000 条内容的数据库体积和关键查询。
- 对所有主要查询执行 `EXPLAIN QUERY PLAN`，记录 `rows_read` 预算。
- 负载测试 3,000 DAU 对应的请求模型，而不是声称做了真实3,000人并发。
- 安全测试、备份/恢复演练、容量降级测试。
- 完善 Deploy 按钮、安装向导、管理员手册、用户隐私与内容规则。

## 14. 验收标准

### 功能验收

- 三种注册模式均可在后台切换并通过测试。
- 邮箱验证码、Passkey、恢复码、邀请、审批流程可完整走通。
- Lv0–Lv4 能正确升级、降级、锁定、通知和记录历史。
- 用户能在允许板块发布 Lv3 主题；只有当前 Lv3/Lv4、作者和授权管理者可以从任一入口访问。
- 主页综合、最新、热门、关注、未读均正确过滤权限。
- 发帖、回复、Markdown、图片、点赞、收藏、举报、通知、搜索、资料页和管理操作可用。
- 图片压缩、公开/私密分流、短期 URL、原图策略、配额和清理可用。
- 达到容量阈值时能够自动降级或关闭新增上传，不影响已有内容阅读。

### 防泄漏验收

对 guest、Lv0–Lv4、作者、普通版主、板块版主、管理员建立参数化矩阵，并验证受限主题不会通过以下路径泄漏：

- 主题详情和直接ID。
- 首页、板块、标签、搜索和联想。
- 用户发言历史、收藏、通知、未读数和统计计数。
- RSS、站点地图、Open Graph、分享预览。
- 图片主图、缩略图、原图和旧缓存 URL。
- API 错误信息、日志和审计的非管理员接口。

### 工程验收

- TypeScript 类型检查、lint、单元、集成、端到端和构建全部通过。
- migration 可在空库执行，也可从上一版本升级；失败可定位。
- 幂等邮件、上传 finalize、点赞和通知不会因重试产生重复数据。
- 关键查询有索引证据和读取预算。
- 仓库无密钥，日志不记录 OTP、session、邀请 token 或 Presigned URL 完整查询参数。
- 新 Cloudflare 账户可按 README 和 Deploy 按钮完成安装。

## 15. 交付物

执行 AI 最终需要交付：

- 可运行源代码和完整测试。
- D1 schema 与 migrations。
- Cloudflare 配置和 Deploy 按钮。
- `.dev.vars.example` 与安装向导。
- README：本地开发、部署、邮件域名、R2 CORS/凭证、Turnstile、自定义域名。
- 架构 ADR：权限模型、认证模型、等级算法、公开/私密媒体、容量与升级路线。
- 管理员手册和备份/恢复步骤。
- 已知限制、真实测试结果、尚未实现项，不得把估算写成实测。

## 16. 官方参考资料

Cloudflare：

- Workers Static Assets 推荐：[Workers Best Practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)
- Workers 免费额度：[Pricing](https://developers.cloudflare.com/workers/platform/pricing/) / [Limits](https://developers.cloudflare.com/workers/platform/limits/)
- D1：[Pricing](https://developers.cloudflare.com/d1/platform/pricing/) / [Limits](https://developers.cloudflare.com/d1/platform/limits/) / [FTS5](https://developers.cloudflare.com/d1/sql-api/sql-statements/)
- R2：[Pricing](https://developers.cloudflare.com/r2/pricing/) / [Presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/) / [Object Lifecycles](https://developers.cloudflare.com/r2/buckets/object-lifecycles/)
- 一键部署及自动资源配置：[Deploy to Cloudflare](https://developers.cloudflare.com/workers/platform/deploy-buttons/)
- Turnstile 免费计划：[Turnstile Plans](https://developers.cloudflare.com/turnstile/plans/)
- Queue 免费额度：[Queues Pricing](https://developers.cloudflare.com/queues/platform/pricing/)
- Cloudflare 邮件限制：[Email Service Pricing](https://developers.cloudflare.com/email-service/platform/pricing/)
- Resend 免费邮件与 Worker 集成：[Resend Pricing](https://resend.com/pricing) / [Cloudflare Integration](https://resend.com/cloudflare)

Discourse：

- 信任等级：[Trust Levels Detailed Explanation](https://meta.discourse.org/t/discourse-trust-levels-a-detailed-explanation/396792/1)
- 注册审核：[Sign-up Approval](https://meta.discourse.org/t/configuring-and-managing-the-sign-up-flow-with-user-approval/112128)
- 邀请/封闭社区：[Closed or Private Community](https://meta.discourse.org/t/configuring-discourse-for-a-closed-or-private-community/27014)
- 板块与用户组权限：[Groups and Category Permissions](https://meta.discourse.org/t/understanding-groups-and-category-permissions/87678)
- 通知级别：[Default Notification Settings](https://meta.discourse.org/t/configuring-default-notification-settings-for-users/285619)
- 审核队列：[Moderation Guide – Managing Content](https://meta.discourse.org/t/discourse-moderation-guide-part-3-managing-content/406266)
- 图片与附件：[Uploads, Images and Attachments](https://meta.discourse.org/t/understanding-uploads-images-and-attachments/275735) / [Client-side Image Optimization](https://meta.discourse.org/t/new-client-side-image-optimizations-for-discourse/402705)

现在请基于本任务书审计工作区、提出简短实施计划并立即开始 Phase 0。不要停留在进一步写策划书。
