# Agent Note: 移除作业“版本沿革”历史链

Status: implemented

## Problem

作业沿革由两级历史表组成：`problems` 模块在策略变化时写
`problem_binding_history`，教学物化器再把每个绑定变化复制到
`assignment_item_history`，由 `GET /domains/:slug/assignments/:id/history` 与
`AssignmentHistory.vue` 分页展示。该组件从未挂载到任何页面（前端入口早已移除），
表只在“记录再读回自己”的链路中存在。唯一的副作用是：`appendAssignmentBindingHistory`
在补录到新的策略变化时顺带投递 `assignment_changed` 通知，物化器再据此跳过重复投递；
`history_pending` 只负责让消费游标多轮一次。它占一张表（4 个外键 + 2 个 CHECK +
1 个唯一键）与约 300 行服务、路由和 UI 代码。

## Decision

删除整条沿革链路：

- Drizzle schema 删除 `assignment_item_history`，迁移 `0138` 只做 `DROP TABLE`。
- 删除 `assignment-history.ts`、`history-read.ts`、`/history` 路由与 `education`
  公共导出；`publishAssignment`、`recomputeAssignmentProgress` 不再写历史。
- `recomputeAssignmentProgress` 不再返回 `history_pending`，教学 outbox 游标只按
  学生分页推进。
- 删除 UI 组件 `AssignmentHistory.vue`、`useEducation.history`、
  `AssignmentHistoryEntry`，以及 E2E 中的沿革断言。
- 保留 `problem_binding_history`（绑定可用性判定与审计依据）。
- `assignment_changed` 通知改由物化器统一投递：作业条目的作答版本、策略版本或可用性
  变化且资源可用时投递一次。条目更新后与资源一致，重算或重试不会再进入该分支，
  因此仍然只投递一次。

## Alternatives considered

- 只删读取与 UI、保留写入：表仍随每次策略变化增长且无人读取，属于死数据。
- 把“已记录”判重改存到 `assignment_items`：条目自身的 `answer_version_id` /
  `policy_revision` / `resource_available` 已经能表达“是否已处理过这次变化”，
  无需新增列。

## Consequences

- 作业详情不再提供“版本与策略变化依据”页面（本就无入口），相关文档已同步。
- 存量库执行 `0138` 后 `assignment_item_history` 数据被删除；策略事实仍可由
  `problem_binding_history` 与审计日志追溯。
- `assignment_changed` / `resource_unavailable` 通知次数不变：原有“策略切换投递一次、
  重算与重试不重复投递”的测试保持原样通过，并新增“恢复授权后再投递一次”的断言。
