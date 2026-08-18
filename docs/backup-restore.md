# D1 与 R2 备份恢复 Runbook

> 当前文档定义操作顺序；自动导出/恢复脚本仍待实现并验证。未完成实际演练前，不得宣称具备完整灾难恢复能力。

## 备份

1. 记录当前 Worker version、Git commit、最新 migration 和 D1 Time Travel bookmark。
2. 使用 Wrangler 导出 D1 schema 与所有业务表到加密的离线位置。
3. 导出 R2 对象清单：bucket、key、size、etag/hash、上传记录 ID、scope。
4. 单独导出非 secret 的站点设置；secret 通过密码管理器/组织密钥系统备份。
5. 核对每张表行数、R2 对象数、总字节和抽样哈希。
6. 至少保留一份 Cloudflare 账户之外的副本。D1 七天 Time Travel 不是跨账户备份。

建议每周逻辑导出；重大 migration 前必须创建恢复点并确认离线备份可读。

## 恢复到新账户/新资源

1. 创建新的 D1、Public R2、Private R2 和 Queue。
2. 在空 D1 执行 migrations，确认版本与备份一致。
3. 按外键依赖顺序导入业务表；禁止在未核验的情况下永久关闭约束。
4. 导入 R2 对象并核对对象数、总字节和文件哈希。
5. 更新 Wrangler 绑定与所有 secrets；不要复用已怀疑泄漏的 token。
6. 重建 FTS 索引与可重算 rollup/hot score。
7. 运行权限 canary：Guest、Lv0–Lv4、作者、板块版主、Admin 从详情、Feed、搜索、通知和媒体入口验证同一受限主题。
8. 核对关键表行数、随机主题楼层、Passkey 登录、OTP、Queue、公开/私密图片。
9. 先绑定临时测试域名，验收后再切换正式域名。

## 错误 migration

优先使用 D1 Time Travel 恢复到 migration 前 bookmark。若已发生不兼容写入，停止非必要写入，保留现场导出，再按明确的数据转换脚本恢复。不要直接修改已发布 migration；新增修复 migration 并记录影响。

## 演练记录

每次演练记录日期、数据规模、导出耗时、恢复耗时、校验结果、失败点和负责人。Phase 4 验收前至少完成一次端到端演练。
