# ADR 0001：Cloudflare 原生运行架构

- 状态：已接受
- 日期：2026-08-16

## 决策

业务系统从零使用 TypeScript 实现，运行于 Workers Static Assets、Workers API、D1、R2、Queues、Cron 和 Turnstile。Discourse 仅作为产品行为、安全机制与信息架构参考，不使用或移植其 Ruby/Rails、PostgreSQL、Redis、Sidekiq 与插件运行时。

SPA 静态文件直接命中 Workers Static Assets；`assets.run_worker_first` 仅包含 `/api/*`。这既降低动态 Worker 请求，也避免为静态资源消耗 CPU。API 使用 Hono，数据访问通过 repository 与中央权限策略实现。

首版保持单 Worker、单 D1 数据库、Public/Private 两个 R2 bucket 和一个邮件 Queue。数据表预留 `content_shard_id`，但在单库接近 300MB 前不实现分片。

## 结果

- 不需要 VPS、容器或常驻进程。
- 平台资源能由 Deploy to Cloudflare 读取 `wrangler.jsonc` 后自动创建。
- 邮件提供商、Turnstile widget 和 R2 S3 Token 仍是部署者必须配置的外部凭据。
- Worker 代码不得执行重型 SSR、服务端图片转码或每次浏览写入。
- 一切平台估算必须与真实测试结果分开记录。
