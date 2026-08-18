# CForum 小白部署教程（Cloudflare 免费版）

> 适用项目：CForum  
> 教程校准日期：2026-08-18  
> 推荐环境：Windows 10/11 + PowerShell + Cloudflare Workers Free  
> 预计耗时：第一次约 40–90 分钟；Resend DNS 验证可能额外等待

这份教程按“没有部署经验也能照做”的方式写。完成后，论坛前端、API、数据库、图片、邮件队列和定时任务都运行在 Cloudflare；邮件验证码由 Resend 发送。

## 先看结论

当前仓库最稳妥的首次部署方式是 **Wrangler CLI**，不是 README 里的 Deploy Button。README 的按钮仍包含 `OWNER/cforum` 占位地址，不能直接使用。

完整流程是：

1. 安装 Node.js 并登录 Cloudflare。
2. 创建 D1、两个 R2 bucket、邮件 Queue 和 DLQ。
3. 将 D1 的真实 ID 写入 `wrangler.jsonc`。
4. 执行远程数据库 migrations。
5. 先部署一次 Worker，取得真正的网址。
6. 配置最终域名、Turnstile、Resend、R2 凭据和 R2 CORS。
7. 写入所有生产 Secrets，再正式部署。
8. 打开网页完成首位管理员初始化并做上线验收。

> **不要在创建 D1 前直接运行 `npm.cmd run deploy`。**  
> 这个脚本的顺序是“构建 → 远程 migration → 部署”。D1 还不存在时，它会在真正部署之前失败。

## 一、需要准备什么

### 必须准备

- 一个 Cloudflare 账户。
- Node.js 22 或更高版本。
- 当前项目文件夹：
  `C:\Users\123\Desktop\project\CForum`
- 一个可用于保存密钥的密码管理器，或至少一张不会上传云端的临时纸质记录。

### 完整注册功能还需要

- 一个 Resend 账户。
- 一个你拥有、能修改 DNS 的域名，用于验证发信身份，例如 `notify.example.com`。
- Cloudflare R2 订阅已启用。

论坛网页本身可以先免费使用 `workers.dev`，不强制购买论坛域名；但 `workers.dev` 不是你的域名，不能拿去验证 Resend。没有自有发信域名时，站主可以先完成安装和浏览测试，但不能向任意新用户稳定发送生产验证码。

### 关于费用

Cloudflare Workers、D1、Queues 和 Turnstile 都有免费计划。R2 有免费包含量，但它是用量计费产品，需要先完成 R2 checkout，有时会要求添加付款方式。超出免费包含量不会自动成为“硬停机开关”，建议稍后设置 Budget Alert。

## 二、先建立一张部署记录

不要把真实值写进本教程、Git、截图或聊天记录。请在密码管理器中建立以下字段：

| 字段 | 从哪里取得 |
|---|---|
| 最终论坛 Origin | 第一次 Worker 部署后取得 |
| Cloudflare Account ID | Cloudflare 账户首页或 R2 页面 |
| D1 Database ID | 创建 `cforum-db` 后取得 |
| Turnstile Site Key | Turnstile Widget |
| Turnstile Secret Key | Turnstile Widget |
| Resend API Key | Resend API Keys |
| EMAIL_FROM | 例如 `CForum <noreply@notify.example.com>` |
| R2 Access Key ID | R2 API Token |
| R2 Secret Access Key | R2 API Token，仅显示一次 |
| 五个 CForum 随机 Secret | 本机生成，彼此不能复用 |

## 三、安装依赖并登录 Cloudflare
  
打开 PowerShell，逐行执行：

~~~powershell
Set-Location "C:\Users\123\Desktop\project\CForum"

node --version
npm.cmd --version
~~~

`node --version` 必须显示 `v22` 或更高。若找不到命令，请安装 [Node.js LTS](https://nodejs.org/) 后关闭并重新打开 PowerShell。

安装锁定版本的依赖：

~~~powershell
npm.cmd ci
~~~

登录 Cloudflare：

~~~powershell
npx.cmd wrangler login
npx.cmd wrangler whoami
~~~

浏览器会弹出 Cloudflare 授权页。完成后，`whoami` 应显示正确账户。若你有多个 Cloudflare 账户，务必现在确认账户正确；D1、R2、Queue 和 Worker 必须在同一个账户。

### 可选但推荐：部署前本地验收

逐行执行；某一步失败就先停止，不要带错部署：

~~~powershell
npm.cmd run typecheck
npm.cmd run lint
npm.cmd test
npm.cmd run build
~~~

最后一条只会构建前端并执行 Cloudflare dry-run，不会发布到线上。

## 四、启用 R2

进入 Cloudflare Dashboard：

`Storage & databases → R2 → Overview`

如果看到启用或 checkout 页面，请完成流程。R2 有免费包含量，但启用订阅不等于设置了消费硬上限。

建议随后进入 Billing 创建 Budget Alert。它只能发提醒，不能自动阻止费用。

## 五、创建 Cloudflare 资源

下面的名字已经写入仓库配置，第一次部署建议不要改名：

- D1：`cforum-db`
- R2：`cforum-public-media`
- R2：`cforum-private-media`
- Queue：`cforum-email`
- Dead Letter Queue：`cforum-email-dlq`

在项目目录的 PowerShell 中逐行执行：

~~~powershell
npx.cmd wrangler d1 create cforum-db --location apac

npx.cmd wrangler r2 bucket create cforum-public-media --location apac
npx.cmd wrangler r2 bucket create cforum-private-media --location apac

npx.cmd wrangler queues create cforum-email
npx.cmd wrangler queues create cforum-email-dlq
~~~

说明：

- `--location apac` 是亚洲位置提示，不是特殊 jurisdiction。不要为这两个 bucket 选择需要 `.eu` 或 `.fedramp` endpoint 的 jurisdiction；当前签名代码使用默认 R2 endpoint。
- 如果提示资源已经存在，不要删除重建。先确认当前 Cloudflare 账户是否正确，再到 Dashboard 核对它是不是本项目的资源。
- 如果任一创建命令询问是否自动修改配置，选择 `No`；仓库里已经有对应 binding，下一节只需手工补入 D1 Database ID，避免产生重复配置。

可用以下命令检查资源：

~~~powershell
npx.cmd wrangler d1 list
npx.cmd wrangler r2 bucket list
npx.cmd wrangler queues list
~~~

## 六、把 D1 Database ID 写入配置

创建 D1 后，终端会输出一个 UUID。打开项目根目录的 `wrangler.jsonc`，找到：

~~~jsonc
"d1_databases": [
  {
    "binding": "CFORUM_DB",
    "database_name": "cforum-db",
    "migrations_dir": "./migrations"
  }
]
~~~

在 `database_name` 后新增 `database_id`，替换为你刚得到的真实 UUID：

~~~jsonc
"d1_databases": [
  {
    "binding": "CFORUM_DB",
    "database_name": "cforum-db",
    "database_id": "这里粘贴真实的-D1-UUID",
    "migrations_dir": "./migrations"
  }
]
~~~

注意：

- 不要粘贴 Cloudflare Account ID。
- 不要再新增第二个 `CFORUM_DB`。
- 如果你自行改了数据库或 bucket 名，必须同步修改 `wrangler.jsonc`；私有 bucket 改名时还要同步修改 `PRIVATE_MEDIA_BUCKET_NAME`。

## 七、初始化线上数据库

现在 D1 已存在，可以安全执行远程 migration：

~~~powershell
npm.cmd run db:migrate:remote
~~~

出现确认提示时，核对目标是 `CFORUM_DB / cforum-db` 后确认。

检查状态：

~~~powershell
npx.cmd wrangler d1 migrations list CFORUM_DB --remote
~~~

当前空库应依次应用：

- `0001_initial.sql`
- `0002_invites_admin_list.sql`

正常完成后不应再显示待执行 migration。

> `--remote` 不能省略。省略后只会改本机模拟数据库，线上仍然没有表。

## 八、第一次部署 Worker，取得网址

第一次部署的目的，是创建 Worker 并得到真实 `workers.dev` 地址。此时 `APP_ORIGIN` 仍可能是仓库占位值，外部服务和 Secrets 也尚未配齐，所以 **先不要初始化管理员，也不要把网址分享出去**。

执行：

~~~powershell
npm.cmd run build
npx.cmd wrangler deploy
~~~

如果 Cloudflare 询问是否创建 `workers.dev` 子域名，按提示创建。

成功后终端会显示类似：

~~~text
https://cforum.<你的账户子域>.workers.dev
~~~

把完整地址记到密码管理器中，不带末尾斜线，例如：

~~~text
https://cforum.my-account.workers.dev
~~~

### 可选：现在就使用自定义域名

如果你已有接入同一 Cloudflare 账户的域名，而且准备正式使用 `forum.example.com`：

1. 进入 `Workers & Pages → cforum`。
2. 打开 `Settings → Domains & Routes`。
3. 选择 `Add → Custom Domain`。
4. 填入 `forum.example.com`，等待证书生效。
5. 将 `https://forum.example.com` 作为后续唯一的最终 Origin。

强烈建议在创建首位管理员和注册 Passkey **之前** 确定最终 hostname。Passkey 与 hostname/RP ID 绑定；先在 `workers.dev` 注册再换域名，会需要在新域名重新注册 Passkey。

## 九、修改生产普通变量

打开 `wrangler.jsonc` 的 `vars`：

~~~jsonc
"vars": {
  "ENVIRONMENT": "production",
  "APP_ORIGIN": "https://cforum.example.com",
  "PRIVATE_MEDIA_BUCKET_NAME": "cforum-private-media",
  "TURNSTILE_SITE_KEY": ""
}
~~~

先把 `APP_ORIGIN` 改为上一步确定的唯一最终地址：

~~~jsonc
"APP_ORIGIN": "https://cforum.my-account.workers.dev"
~~~

或：

~~~jsonc
"APP_ORIGIN": "https://forum.example.com"
~~~

要求：

- 必须是 HTTPS。
- 只能包含协议、hostname 和必要端口。
- 不要带路径、查询字符串、`#` 或末尾斜线。
- 实际访问地址必须与它一致，否则写操作会返回 `INVALID_REQUEST_ORIGIN`，Passkey 也会失败。
- 保持 `ENVIRONMENT` 为 `production`。
- 保持 `PRIVATE_MEDIA_BUCKET_NAME` 与真实私有 bucket 名完全一致。

`TURNSTILE_SITE_KEY` 在创建 Widget 后再填写。

## 十、配置 R2 图片直传

CForum 使用两层媒体存储：

- `cforum-private-media`：临时图片、受限图片和隔离图片。
- `cforum-public-media`：真正可由 Guest 查看内容的最终图片副本。

虽然第二个名字里有 `public`，**两个 bucket 都必须保持私有**。不要开启 `r2.dev`，也不要给 bucket 绑定公开媒体域名。浏览器读取图片必须经过 `/api/media/:uploadId`，这样 Worker 才能重新检查帖子等级和板块权限。

### 10.1 创建 R2 S3 API Token

进入：

`R2 Object Storage → Account Details / Manage R2 API Tokens`

创建 Token：

- 权限选择 `Object Read & Write`。
- 最小权限只授权 `cforum-private-media` 即可。
- 不要选择 `Admin Read & Write`。
- 保存 `Access Key ID` 和 `Secret Access Key`；Secret 只显示一次。
- 记下 Cloudflare `Account ID`，它不是 Zone ID。

R2 Worker binding 不能代替这里的 S3 凭据。浏览器通过 Presigned PUT 直传私有 bucket，Worker 必须用这组 S3 凭据签名。

### 10.2 只给 Private bucket 配 CORS

进入：

`R2 → cforum-private-media → Settings → CORS Policy → Add CORS policy`

把下面的 Origin 替换成最终 `APP_ORIGIN`，然后在控制台 JSON 编辑器中粘贴：

~~~json
[
  {
    "AllowedOrigins": [
      "https://cforum.my-account.workers.dev"
    ],
    "AllowedMethods": [
      "PUT"
    ],
    "AllowedHeaders": [
      "Content-Type",
      "x-amz-checksum-sha256"
    ],
    "ExposeHeaders": [
      "ETag"
    ],
    "MaxAgeSeconds": 3600
  }
]
~~~

要求：

- Origin 必须精确匹配，而且不能带末尾斜线。
- 只允许 `PUT`。
- 两个请求头都不能漏。
- 不要给 Public bucket 配公开读或公开 CORS。
- CORS 只允许浏览器发送已签名请求，本身不是授权机制。
- 保存后偶尔需要等待约 30 秒传播。

仓库的 `docs/r2-cors.example.json` 是给 Cloudflare **控制台** 粘贴的数组格式。新版 Wrangler 的 `r2 bucket cors set` 使用另一种 `rules/allowed` 格式；不要把两种格式混用。本教程对小白统一采用控制台操作。

## 十一、配置 Turnstile

进入 Cloudflare Dashboard 的 `Turnstile`，选择 `Add widget`：

- Widget name：例如 `CForum Production`。
- Widget mode：`Managed`。
- Hostname：只填 hostname，不带 `https://` 和路径。
  - 例如 `cforum.my-account.workers.dev`
  - 或 `forum.example.com`

创建后会得到：

- Site Key：公开值。
- Secret Key：私密值。

把 Site Key 写入 `wrangler.jsonc`：

~~~jsonc
"TURNSTILE_SITE_KEY": "这里粘贴真实-Site-Key"
~~~

Secret Key 稍后通过 `wrangler secret put TURNSTILE_SECRET` 写入，不能放进配置文件。

程序会自动使用 `email_request_code` 和 `registration_submit` 两个 action，不需要在 Dashboard 额外创建 action。

## 十二、配置 Resend 邮箱验证码

如果只想先让站主浏览，可以稍后做本节；如果要让其他用户注册，本节是必需的。

### 12.1 验证发信域名

1. 登录 Resend。
2. 打开 `Domains`，添加你拥有的域名。
3. 推荐使用邮件子域名，例如 `notify.example.com`。
4. 如果 DNS 在 Cloudflare，可优先用 Resend 的 `Sign in to Cloudflare` 自动配置。
5. 等待 SPF、DKIM 等记录全部显示 Verified。

DNS 传播通常较快，最慢可能需要 72 小时。`workers.dev` 不能作为 Resend 验证域名。

### 12.2 创建最小权限 API Key

进入 Resend `API Keys`：

- 创建 `Sending access` Key。
- 尽量限制到刚验证的发信域名。
- 不要使用 `Full access`。
- Key 只显示一次，立即保存。

准备发件人字符串，例如：

~~~text
CForum <noreply@notify.example.com>
~~~

生产环境缺少 `RESEND_API_KEY` 或 `EMAIL_FROM` 时，验证码接口为防账号枚举仍可能显示“已受理”，但不会真正发信；这是 fail-closed 行为。

## 十三、生成 CForum 自身的随机 Secrets

下面五个值必须独立生成，不能复用，也不能使用示例文字：

- `SESSION_HMAC_SECRET`
- `OTP_HMAC_SECRET`
- `INVITE_HMAC_SECRET`
- `WEBAUTHN_CHALLENGE_SECRET`
- `BOOTSTRAP_ADMIN_SECRET`

在本机 PowerShell 执行一次：

~~~powershell
node -e "const {randomBytes}=require('node:crypto'); for (const name of ['SESSION_HMAC_SECRET','OTP_HMAC_SECRET','INVITE_HMAC_SECRET','WEBAUTHN_CHALLENGE_SECRET','BOOTSTRAP_ADMIN_SECRET']) console.log(name + '=' + randomBytes(48).toString('base64url'))"
~~~

会输出五行彼此不同的值。立即放入密码管理器，然后清屏：

~~~powershell
Clear-Host
~~~

要求：

- 前四个代码最低要求 32 字符；这里生成 48 个随机字节，足够。
- Bootstrap 代码最低要求 24 字符，仍使用相同强度。
- 不要保存到 `wrangler.jsonc`、`.dev.vars`、`.env`、Git、截图或聊天。
- `.dev.vars` 只用于本机开发，不会自动上传为生产 Secret。

## 十四、写入全部 Worker Runtime Secrets

Worker 已在第八节创建，现在可以逐条执行。每条命令出现提示后，粘贴对应值并按 Enter；输入不回显通常是正常现象。

### CForum 自身 Secrets

~~~powershell
npx.cmd wrangler secret put SESSION_HMAC_SECRET
npx.cmd wrangler secret put OTP_HMAC_SECRET
npx.cmd wrangler secret put INVITE_HMAC_SECRET
npx.cmd wrangler secret put WEBAUTHN_CHALLENGE_SECRET
npx.cmd wrangler secret put BOOTSTRAP_ADMIN_SECRET
~~~

### Turnstile

~~~powershell
npx.cmd wrangler secret put TURNSTILE_SECRET
~~~

### Resend

~~~powershell
npx.cmd wrangler secret put RESEND_API_KEY
npx.cmd wrangler secret put EMAIL_FROM
~~~

`EMAIL_FROM` 粘贴完整字符串，例如 `CForum <noreply@notify.example.com>`。

### R2 S3 凭据

~~~powershell
npx.cmd wrangler secret put R2_ACCOUNT_ID
npx.cmd wrangler secret put R2_ACCESS_KEY_ID
npx.cmd wrangler secret put R2_SECRET_ACCESS_KEY
~~~

说明：

- `R2_ACCOUNT_ID` 本身不算敏感值，但作为 runtime secret 保存最省事。
- `R2_ACCESS_KEY_ID` 和 `R2_SECRET_ACCESS_KEY` 必须来自 R2 API Token，不是普通 Cloudflare API Token。
- `wrangler secret put` 会立即创建并部署新 Worker 版本。
- 当前项目没有用 `secrets.required` 阻止漏配，所以“部署成功”不等于 Secret 已齐；必须按上面的 11 项逐一核对。
- 在 Workers Builds 页面填写的 Build Secret，不等于线上 Worker Runtime Secret。

## 十五、正式部署

确认以下三项已经改好：

- `wrangler.jsonc` 有真实 `database_id`。
- `APP_ORIGIN` 是唯一最终地址。
- `TURNSTILE_SITE_KEY` 不是空字符串。

然后执行：

~~~powershell
npm.cmd run deploy
~~~

这个脚本会依次：

1. 构建 React 静态文件。
2. 执行 Wrangler dry-run。
3. 对远端 `CFORUM_DB` 应用尚未执行的 migrations。
4. 部署 Worker、Static Assets、邮件 Queue consumer 和三个 Cron Trigger。

再次检查 migration：

~~~powershell
npx.cmd wrangler d1 migrations list CFORUM_DB --remote
~~~

已配置的三个 Cron 是：

~~~text
17 2 * * *
*/15 * * * *
7 * * * *
~~~

Cloudflare Cron 一律使用 UTC，不是台湾/中国本地时间；变更可能最长等待约 15 分钟生效。

## 十六、健康检查

把变量换成你的真实 Origin：

~~~powershell
$CForumOrigin = "https://cforum.my-account.workers.dev"

Invoke-RestMethod "$CForumOrigin/api/health" | ConvertTo-Json
Invoke-RestMethod "$CForumOrigin/api/site" | ConvertTo-Json
Invoke-RestMethod "$CForumOrigin/api/bootstrap/status" | ConvertTo-Json
~~~

健康接口应包含：

~~~json
{
  "ok": true,
  "environment": "production",
  "database": "ready"
}
~~~

Bootstrap 状态第一次应为：

~~~json
{
  "installationRequired": true
}
~~~

如果 `/api/health` 是 503，先不要初始化，直接看后面的故障表。

## 十七、创建首位管理员

用浏览器打开最终论坛地址。安装向导会要求：

- 站点名：1–80 字符。
- 管理员用户名：3–32 字符，可用 Unicode 字母、数字、`_`、`-`。
- 显示名：1–80 字符。
- 管理员邮箱。
- 注册模式。
- `BOOTSTRAP_ADMIN_SECRET`。

第一次建议选择 **注册审核制**。邮件、Turnstile、邀请、图片和 Passkey 全部验收后，再考虑开放自由注册。

安装成功后会：

- 创建唯一的 Lv4 Admin。
- 创建五个初始板块。
- 建立管理员登录 Session。
- 永久写入数据库 bootstrap claim，防止第二次初始化。

### 安装成功后立即做两件事

1. 按页面提示为管理员注册 Passkey；最好准备两个不同设备的 Passkey。
2. 轮换 `BOOTSTRAP_ADMIN_SECRET`，不能删除：

~~~powershell
node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"
npx.cmd wrangler secret put BOOTSTRAP_ADMIN_SECRET
~~~

第二条命令提示后，粘贴刚生成的新值。新值只用于让旧 bootstrap secret 失效；数据库中的唯一 claim 仍会阻止重复安装。

## 十八、上线验收清单

不要只看首页能打开。请逐项实际测试：

- [ ] 无痕窗口可以加载首页和公开主题。
- [ ] 管理员退出后能用 Passkey 重新登录。
- [ ] 测试邮箱能收到验证码。
- [ ] 注册模式、注册审核或邀请注册符合预期。
- [ ] 管理页能生成一次性邀请并撤销未用邀请。
- [ ] 能发主题、回复、点赞和收藏。
- [ ] 能上传一张图片，刷新页面后仍显示。
- [ ] Lv3 可见主题不会泄露给低等级账号或游客。
- [ ] 管理页能开启并关闭只读维护。
- [ ] Queue 没有持续 retry，DLQ 没有新增失败消息。
- [ ] 两个 R2 bucket 都没有 `r2.dev` 或公开自定义域名。
- [ ] Worker 的三个 Cron Trigger 都存在。
- [ ] 日志中没有 OTP、Session、邀请 token、邮件正文或完整 Presigned URL。

查看实时 Worker 日志可执行：

~~~powershell
npx.cmd wrangler tail
~~~

查看邮件队列与 DLQ，进入 Cloudflare `Queues` 页面。查看邮件投递结果，进入 Resend `Emails / Logs`。

## 十九、免费版能运行到什么规模

以下为 2026-08-18 的关键免费边界；厂商可能调整，请以上线时官方页面为准。

| 服务 | 免费版关键边界 | 对 CForum 的实际含义 |
|---|---|---|
| Workers | 100,000 动态请求/日；10 ms CPU/次 | `/api/*` 和 `/api/media/*` 会消耗请求；静态资源请求不计入动态额度 |
| D1 | 500 万 rows read/日；10 万 rows written/日；单库 500 MB | 本项目只有一个主库，先碰到的是单库 500 MB，不是账户总 5 GB |
| R2 Standard | 10 GB-month；100 万 Class A/月；1,000 万 Class B/月；公网出网免费 | 项目在 7 GiB 告警、8 GiB 停止新增上传 |
| Queues | 10,000 operations/日；免费版 retention 24 小时 | 一封成功邮件通常至少产生写、读、删三次 operation |
| Turnstile | challenge/verification 不限；20 个 Widget；每个 10 个 hostname | 一个生产 Widget 足够 |
| Cron | 免费账户最多 5 个 | 本项目已使用 3 个 |
| Resend Free | 100 封/日；3,000 封/月；1 个域名 | 邮件通常会比 Queue 更早成为注册瓶颈 |
| Workers Builds | 3,000 分钟/月；1 并发；单次 20 分钟 | 当前主教程走本机 CLI，不依赖它 |

仓库的工程目标是约 3,000 DAU、30,000 用户、约 80,000 条主题首帖与回复、15,000–18,000 张长期压缩图片；这是设计目标，不是 Cloudflare SLA 或真实账户压测承诺。详细保护线见 `docs/adr/0005-capacity.md`。

特别注意：

- 图片读取也经过 Worker，因此一张页面包含多张图片时，会同时消耗 Worker 请求和 R2 Class B。
- Resend 免费版每天 100 封，通常是最早出现的增长瓶颈。
- R2 免费包含量不是硬封顶；设置 Budget Alert 只能提醒。
- 达到约 2,500 DAU 或任一保护线 70% 时，应评估 Workers Paid，而不是等故障发生后再处理。

## 二十、以后如何更新部署

拿到新代码后，不要修改已经在线执行过的 migration。按顺序执行：

~~~powershell
Set-Location "C:\Users\123\Desktop\project\CForum"

npm.cmd ci
npm.cmd run typecheck
npm.cmd run lint
npm.cmd test
npm.cmd run deploy
~~~

重大 migration 前先按 `docs/backup-restore.md` 做备份/恢复检查。

普通变量以 `wrangler.jsonc` 为准；你只在 Dashboard 修改 `APP_ORIGIN` 或 `TURNSTILE_SITE_KEY`，下次 Wrangler 部署可能会被本地配置覆盖。

## 二十一、更换域名时必须同步修改什么

CForum 当前只允许一个写入 Origin。若从 `workers.dev` 改成自定义域名，必须一次完成：

1. 为 Worker 添加 Custom Domain。
2. 把 `wrangler.jsonc` 的 `APP_ORIGIN` 改成新 HTTPS Origin。
3. 把新 hostname 加到 Turnstile Widget。
4. 把 Private R2 CORS 的 AllowedOrigins 改成新 Origin。
5. 重新执行 `npm.cmd run deploy`。
6. 用新域名测试邮箱登录、发帖、图片上传和 Passkey。
7. 在新 hostname 重新注册 Passkey。

最安全的做法是 **首位管理员初始化前就确定最终域名**。如果已经上线才切换，先确保 Resend 邮箱登录已真实可用，否则旧域名 Passkey 无法在新 RP ID 使用时，可能把管理员锁在外面。

## 二十二、常见错误对照

| 现象 | 最常见原因 | 怎么处理 |
|---|---|---|
| 找不到 `node`、`npm`、`npx` | 未安装 Node，或安装后没重开终端 | 安装 Node.js 22+，重新打开 PowerShell |
| PowerShell 禁止执行脚本 | 调用了 `npm.ps1` / `npx.ps1` | 使用教程中的 `npm.cmd`、`npx.cmd` |
| migration 阶段就失败 | D1 未创建、ID 错误或账户选错 | `wrangler whoami`、`d1 list`，核对 `database_id` |
| Queue 或 DLQ 不存在 | 漏建 `cforum-email` / `cforum-email-dlq` | 创建后重新部署 |
| `/api/health` 返回 503 | D1 未绑定或 migration 未执行 | 核对绑定并运行 `db:migrate:remote` |
| 安装提交返回 404 | Bootstrap secret 不符或不足 24 字符 | 重新设置强随机 `BOOTSTRAP_ADMIN_SECRET` |
| 安装提交返回 500 | Session secret 缺失或太短 | 核对 `SESSION_HMAC_SECRET` |
| 登录/注册按钮禁用 | `TURNSTILE_SITE_KEY` 仍为空 | 写入 `wrangler.jsonc` 并重新部署 |
| `TURNSTILE_FAILED` | Site Key/Secret 不配对，或 hostname/Origin 错 | 同时核对四项并重新部署 |
| 点击验证码但收不到 | Resend/`EMAIL_FROM` 缺失、域名未验证、Queue retry 或超额度 | 查 Resend Logs、Queue 和 DLQ |
| `INVALID_REQUEST_ORIGIN` | 实际网址与 `APP_ORIGIN` 不一致 | 统一协议和 hostname，不带路径 |
| Passkey 配置失败 | Origin 非 HTTPS、带路径，或 challenge secret 太短 | 修正配置并从最终域名重试 |
| `MEDIA_SIGNING_UNAVAILABLE` | R2 Account ID、S3 Key、Secret 或私有 bucket 名错误 | 核对 R2 Token 和 `PRIVATE_MEDIA_BUCKET_NAME` |
| 图片提示 CORS/网络错误 | CORS 配错 bucket、Origin/请求头不匹配 | 只检查 Private bucket 的 PUT CORS |
| R2 CORS CLI 报 `rules` 错误 | 把控制台数组格式交给新版 Wrangler | 本教程用控制台粘贴；不要混用格式 |
| Dashboard 变量下次又变回去 | Wrangler 本地配置覆盖了 Dashboard | 修改 `wrangler.jsonc` 后重新部署 |
| Deploy Button 指向错误项目 | README 仍是 `OWNER/cforum` 占位值 | 当前使用本教程的 CLI 流程 |
| 推送 GitHub 后没有自动上线 | 当前 GitHub Action 只做 CI | 手工 `npm.cmd run deploy`，或以后单独配置 Workers Builds |
| Cloudflare Error 1027 | Workers Free 当日请求额度耗尽 | 等 UTC 0 点重置或升级 Workers Paid |

## 二十三、官方参考资料

Cloudflare：

- [Wrangler CLI 入门](https://developers.cloudflare.com/workers/get-started/guide/)
- [Wrangler 配置](https://developers.cloudflare.com/workers/wrangler/configuration/)
- [Worker Secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
- [workers.dev](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/)
- [Worker Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)
- [Workers 免费限制](https://developers.cloudflare.com/workers/platform/limits/)
- [D1 入门与 Binding](https://developers.cloudflare.com/d1/get-started/)
- [D1 Migrations](https://developers.cloudflare.com/d1/reference/migrations/)
- [D1 定价与免费额度](https://developers.cloudflare.com/d1/platform/pricing/)
- [D1 平台限制](https://developers.cloudflare.com/d1/platform/limits/)
- [R2 入门与订阅](https://developers.cloudflare.com/r2/get-started/)
- [R2 S3 API Token](https://developers.cloudflare.com/r2/api/tokens/)
- [R2 CORS](https://developers.cloudflare.com/r2/buckets/cors/)
- [R2 定价与免费额度](https://developers.cloudflare.com/r2/pricing/)
- [Queues 定价与免费额度](https://developers.cloudflare.com/queues/platform/pricing/)
- [Queues 限制](https://developers.cloudflare.com/queues/platform/limits/)
- [Turnstile Widget](https://developers.cloudflare.com/turnstile/get-started/widget-management/dashboard/)
- [Turnstile Hostname 管理](https://developers.cloudflare.com/turnstile/additional-configuration/hostname-management/)
- [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)

Resend：

- [Cloudflare DNS 域名验证](https://resend.com/docs/knowledge-base/cloudflare)
- [Resend API Keys](https://resend.com/docs/dashboard/api-keys/introduction)
- [Resend 免费额度](https://resend.com/docs/knowledge-base/what-is-resend-pricing)
- [Resend 账户限额](https://resend.com/docs/knowledge-base/account-quotas-and-limits)

## 最后检查

全部打勾后才适合邀请真实用户：

- [ ] `APP_ORIGIN` 是最终 HTTPS Origin。
- [ ] Turnstile Site Key、Secret、hostname 一致。
- [ ] Resend 域名已 Verified，测试验证码能收到。
- [ ] D1 两个 migration 均已应用。
- [ ] 两个 R2 bucket 都保持私有。
- [ ] Private R2 的 PUT CORS 已按最终 Origin 配置。
- [ ] 11 个 Worker runtime secrets 均已设置。
- [ ] 管理员已注册 Passkey。
- [ ] `BOOTSTRAP_ADMIN_SECRET` 已轮换。
- [ ] Queue、DLQ、三个 Cron 均已核对。
- [ ] 图片上传、等级可见性和维护模式均已实测。
- [ ] Cloudflare Budget Alert 已设置。
