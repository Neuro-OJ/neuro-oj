# Agent Note: 五题型教学与真实 S3 纳入正式 E2E 门禁

Status: implemented

## Problem

比赛与教学使用独立 CI runner，比赛 job 构建的 Native C++ 镜像不能供教学 job
使用。提交 job 的 local 存储配置也会跳过真实 S3 支持包测试。

## Decision

cross-domain job 与比赛一致启用 ai、oi-native，并在自身 runner 构建 C++
镜像。submission 的复合 action 在普通链路完成后，使用既有 S3 overlay 重建 core
并等待健康，再通过标准域入口执行八项真实 MinIO 验收。 overlay
变更进入基础设施路径过滤。测试结束沿用隔离栈清理流程。

## Alternatives considered

- 引用另一个 job 的本地镜像：runner 不共享 Docker 状态。
- 继续跳过 S3 并只记录本地验收：不能防止正式 CI 中存储契约回归。
- 新建重复提交 job：既有隔离栈可以顺序完成两种存储，不重复构建整个栈。

## Consequences

教学 OI 和 S3 测试均有正式 CI 执行条件。此前本地真实五题型旅程通过六个
步骤，真实 S3 八项通过；工作流静态检查与 Compose 校验另行记录。本文不将
尚未执行的远端 CI 描述为通过。
