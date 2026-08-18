# ADR 0002：等级、板块 ACL 与主题权限

- 状态：已接受
- 日期：2026-08-16

## 普通访问

Guest 的只读等级视为 Lv0。普通用户访问必须同时满足：

```text
当前等级 >= max(category.min_view_level, topic.min_view_level)
AND Category ACL 允许 See
AND 内容状态允许普通读取
```

`effective_min_view_level` 是索引用冗余值；服务端仍以 category、topic 和冗余值三者最大值进行 fail-closed 检查。`acl_mode=restricted` 且没有匹配授权时拒绝，不能因 ACL 记录为空而开放。

See、Reply、Create 相互独立。Create/Reply 必须额外满足 See、各自最低等级和 active 账号状态。Guest 永远不能写入。

## 管理角色

Active Admin 可读取所有未物理清除内容，但仍应先解除锁定或归档再发言，以保留审计语义。Moderator 仅在 `moderator_category_scopes` 明确列出的板块获得管理读取和内容治理能力；普通发帖仍按自身等级与 ACL。板块授权不自动继承子板块。

版主不能审批注册、修改角色/等级/ACL/站点设置或执行全站处罚。移动主题要求同时拥有来源和目标板块权限。

## 作者降级

作者发布高等级主题时保存 `author_qualified_visibility_level`。作者当前等级低于主题有效等级后：

- 仅作者本人可通过 `author_read_only` 例外直接读取；
- 例外只绕过等级，不绕过 Group ACL、账号停权或内容删除；
- 主题产生全局 `author_downgrade` 回复锁，其他合资格读者也不能回复；
- 作者恢复等级后派生锁自动解除，手工锁与归档状态不受影响；
- 附件随父主题继承同一只读访问。

初始 migration 的 `users_topics_author_downgrade_lock` trigger 在 `trust_level` 变化时维护该派生锁；手工锁继续由 `topics.status/manual_lock_reason` 独立表达。自动等级计算器尚未完成，但无论以后由 Cron、惰性复核还是管理员操作更新等级，都必须走同一数据库不变量。

## 防泄漏

不可见与不存在在对象 API 上使用相同 404、响应体和 `Cache-Control: private, no-store`。首页、板块、搜索、联想、用户历史、收藏、通知、计数、RSS、站点地图、Open Graph 与媒体必须复用同一可见性 scope，不得在控制器中另写权限 SQL。

只有以 Guest 调用 `canViewTopic` 成功的媒体才能进入 Public R2；`min_view_level=0` 本身不足以证明公开。
