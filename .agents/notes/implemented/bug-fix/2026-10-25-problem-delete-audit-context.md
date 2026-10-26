# Agent Note: 题目删除审计显式进入请求上下文

Status: implemented

## Problem

题目删除 HTTP 路由已经把认证用户转换为 `UserActor`，但调用新的 application
command 前没有进入旧审计适配层所读取的 `RequestContext`。删除事务成功后，
`finalizeDeletedProblem()` 调用 `logAudit()`
时取不到上下文，适配层静默放弃写入， 导致真实 system E2E 找不到
`problems.delete` 审计记录；题目本身仍会成功删除， 形成审计缺失。

## Decision

- 在 `DELETE /api/v1/problems/:id` 的 command 调用范围内使用统一的
  `withActorContext(c, ...)`，让已认证的 actor、客户端 IP 和请求元数据贯穿事务
  提交后的审计收尾。
- 保留 application command 的显式 `UserActor` 参数和现有事务边界，不把 Hono
  Context 传入业务层，也不在审计失败时回滚已经成功的删除。

## Alternatives considered

- 在 `finalizeDeletedProblem()` 中重新从全局或默认用户推断操作者：放弃，会违反
  Actor 边界并可能把审计归给错误主体。
- 让审计查询在找不到记录时等待：放弃，根因是 HTTP
  适配上下文缺失，不是最终一致性。
- 给删除接口单独拼接一套审计 INSERT：放弃，会绕过平台审计合同和统一 IP/actor
  映射。

## Consequences

题目删除的真实 HTTP 链路现在会记录带目标题目 ID、认证操作者和客户端 IP 的
`problems.delete` 事实，同时保持删除事务和审计辅助失败语义不变。system E2E
需在新栈上复跑确认；旧 service 单测继续使用其显式测试 context。
