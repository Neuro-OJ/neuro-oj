# Agent Note: 评论举报通知使用可信举报域

Status: implemented

## Problem

旧管理入口处理评论举报时不传社区 scope，以保留原平台封禁权限边界。 评论举报的
post_id 为空；通知服务只能从 scope、可信域参数或实际帖子取得归属，
因此处理通知会错误保存空域。私信举报的空域则具有正常账号层面的意义。

## Decision

创建、处理和重新开启举报的三条通知调用均传入当前持久举报记录的 domain_id。
通知使用已经创建或 RETURNING 的可信事实，不增加查询，也不从客户端通知 data
取域。 评论举报归 main，私信举报继续保持空域，原平台权限和内容治理 scope 不变。

新增隔离服务／HTTP 回归验证：评论举报的创建、旧管理处理、旧管理重开三条通知均归
main； 私信举报对应三条通知均保持 NULL。

## Alternatives considered

- 缺域通知默认归 main：会把全站私信事件错误归域。
- 通知服务额外查询评论、举报并自动修复：调用者已有可信举报行，无需增加解析层。
- 为传递归属修改旧治理 scope
  或放宽封禁权限：归属与平台治理权限是不同事实，保持既有边界。

## Consequences

生产改动只有三个可信参数，不修改通知 Schema、迁移或其他调用者。 回归通过标准
community 测试入口在 PostgreSQL 与 PGlite 执行，
可以纳入后续通知的条件非空约束检查。 community 两库各通过 84 项；完整 core
类型检查、受影响文件格式及 lint、Agent Note 校验通过。
