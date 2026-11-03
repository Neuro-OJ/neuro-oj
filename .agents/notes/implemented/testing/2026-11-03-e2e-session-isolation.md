# Agent Note: 本地 E2E 会话隔离与构建产物复用

Status: implemented

## Problem

本地 E2E 依赖固定容器名（`noj-e2e-core` 等）、固定主机端口（5433/6380/8099）
与全局 `/tmp/noj-e2e-env.sh`：两个会话不能并行，清理只能靠固定名字猜测归属，
且每次启动重复构建 UI 与题目支持包。

## Decision

- `scripts/e2e/session.ts` 以 session 为唯一入口：`up/down/show/env`，清单写入
  `noj-tests/test-results/e2e-sessions/<name>.json`，包含 project、owner label、
  端口、evaluator 网络、镜像/UI/支持包 fingerprint、产物摘要、reusedSession 与
  清理错误。同名 session 已存在时拒绝覆盖，必须先 `env:down`。
- Compose 删除全部 `container_name`，8 个主机端口全部参数化；project 名为
  `noj-e2e-<session>-<random>`，evaluator 网络按 run 命名并传给 Judge；
  `noj-e2e-llm-mock` / `noj-e2e-test-coordinator` 只保留网络内 alias。
- 端口先用真实监听探测，启动后回读 Compose 实际端口写回清单；端口冲突换整套
  端口重试。清理前核对 session、project 与 owner label，只删除本会话资源；
  清理失败保留清单与 `lastCleanupError` 供审计/重试。
- `artifact-cache.ts`：输入 fingerprint 与产物摘要同时一致才复用 UI/支持包；
  `--fresh` 强制重建；复用结论写入运行清单，避免与 clean-run 基线混合。

## Alternatives considered

- 继续使用固定端口/容器名：无法并行，清理范围不可证明。
- 每个 session 手动复制 compose override：配置容易漂移，端口仍可能冲突。
- 只用 Docker namespace/label 隔离而不改端口：本地主机端口仍会冲突。
- 只缓存构建产物不校验摘要：源码变化或产物损坏时会执行旧产物。

## Consequences

- 真实单会话全链路：`env:up --fresh`（reusedSession=no）→ `env:up`（hit=yes）→
  `test:domain submission --session`（canary 真跑、6 passed/6s）→ `env:down`
  （容器 11→0、网络/卷/清单全部清理）；`--fresh` 重建不会把 reusedSession 误标为
  true。
- 双 session 实测（coordinator-only 栈）project/端口/网络/容器名互不冲突，
  `down a` 不影响 b 或共享栈；全栈双会话（migrate+seed 约 25–30 分钟/套）未跑。
- CI 仍使用固定默认端口与一次镜像构建 + tar artifact 分发；本地与 CI 共用
  session 脚本，但 CI 不依赖本地缓存。
- 清理不再有第二套 bash 所有权逻辑：`teardown.sh` 委托 `session.ts down`。
