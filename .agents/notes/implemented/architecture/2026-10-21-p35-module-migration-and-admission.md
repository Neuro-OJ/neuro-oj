# Agent Note: P3.4 评测受理接线与 P3.5 模块迁移

Status: implemented

## Problem

评测提交、产物提交和自测在 application 层已经能够组合执行上下文，但领域写入仍可能在
事务内重新查找比赛/教学上下文；同时 education、communication 和 read-models 的生产实现
仍位于旧 `domains` 根，导致目标模块目录与真实调用入口不一致，测试发现也容易在搬迁后静默
缩小。

## Decision

1. application 组合完整的 `DomainEvaluationAdmissionPlan`，包含请求、授权上下文和解析后的
   执行选择；代码、产物、预测和自测的写入事务在最终落库前调用
   `revalidateEvaluationAdmissionTx`，并保留旧无计划入口作为迁移期兼容路径。
2. 将 education、community、messaging、content-review、query 和 search 的实现与测试迁入
   `modules/education`、`modules/communication/*` 和 `modules/read-models/*`；教学事实登记
   进入 education contracts，不再由 `shared` 持有业务事实写入。
3. 测试 launcher 与模块元数据同时登记嵌套目标根，保证正式 `deno task` 分片继续发现搬迁后
   的测试；迁移期不删除尚未切完的旧域，以便后续按调用图收口而不是用路径兼容掩盖依赖。

## Alternatives considered

- 只在路由层读取一次授权并把结果传入写入函数：不能防止事务开始后成员/版本/比赛状态变化，
  因而保留事务内二次复核。
- 只移动目录而不更新 launcher 和事实合同：会产生“源码已迁移、测试未执行”或 shared
  继续成为业务写入口的假完成，拒绝采用。
- 立即删除全部旧域：会同时破坏尚未迁移的 HTTP/runtime 入口，且无法区分结构迁移错误与
  业务行为回归，改为分批切换后再删除。

## Consequences

- P3.4 的新调用方不再需要在 evaluations 内自行寻找跨模块执行上下文；旧入口仍需在 P3.7
  清理，不能据此宣称全部旧实现已删除。
- education、communication 和 read-models 的正式类型检查已覆盖新路径，模块元数据无缺失；
  当前剩余结构缺口是 HTTP/runtime 装配、旧域删除、门面显式导出和运行时环，继续归入 P3.6–P3.8。
- 目录搬迁不改变物理表、API 语义或生产资源；所有真实数据库回归继续使用本轮专属隔离环境。
