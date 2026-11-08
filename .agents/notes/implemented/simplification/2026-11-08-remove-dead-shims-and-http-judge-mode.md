# Agent Note: 删除死代码、转发 shim 与 RUNTIME_JUDGE_MODE=http

Status: implemented

## Problem

Issue #726（精简冗余（二）P1）核实到多处“已无实际行为”的代码：未被挂载的
OI 作者路由、恒为假的题解作者权限限制、仅做转发的 `@deprecated` shim、重复的 env
快照层、只会变化为 `"heartbeat"` 的 `RUNTIME_JUDGE_MODE` 分支，以及只出现在帮助文本
里的 `noj-cli judge calibrate`。它们让读者误以为存在对应约束或能力。

## Decision

- 删除 `modules/problems/routes/oi-author.ts`（无挂载点、前端走域入口）与仅它使用的
  `authorizeOiData`。
- 删除 `modules/problems/services/workspace/problem-contest-authoring.ts`：
  `problemAuthoringRestrictionSql` 恒为 `false`，另两个函数为空操作；调用点的恒假 SQL
  条件与恒假分支一并删除。`canEdit` 直接由 `platformAdmin` 或
  `problem:write_any` 决定。
- 删除 `RUNTIME_JUDGE_MODE`：`runtime-contract.ts` 的 judge 描述符固定
  `mode: "heartbeat"`，设置注册表、`docker-compose.prod.yml`、`.env.prod.example`、
  `noj-core/.env.example` 中的条目一并移除。
- 删除 env 快照层（两份 `env-snapshot.ts`）：bootstrap 项与 runtime 兜底统一实时读取
  `Deno.env`。进程内快照只节省一次哈希查找，却引入了“快照与真实 env 不一致”的
  第二真相源。
- 删除 `platform/system/services/` 下纯转发的 shim（system-settings、
  instance-settings、announcements、content-scope、judge-images、types/audit-log），
  导入方直接指向 `platform/services/` 的真实实现。
- `noj-cli`：从帮助文本与 README 删除不存在的 `judge calibrate`。

## Alternatives considered

- **保留 `platform/system/services/audit-log.ts`**：它不是纯转发。`logAudit` 从请求
  上下文取 actor，无上下文时静默降级；管理网关、提交、社区等路由在 `withActorContext`
  之外调用 `adminAudit()`。直接改指 `recordAuthAudit` 会让审计失去真实操作者、
  并可能在无 actor 时抛错返回 500。
- **合并而非删除 env 快照**：快照的唯一意义是“启动期冻结”，而所有消费方都期望读到
  当前 env；合并后仍是同一层多余间接，故整体删除。
- **保留 `RUNTIME_JUDGE_MODE`**：judge 只有心跳上报，没有 HTTP 健康/指标端点，
  `http` 模式从未可用。

## Consequences

- `updateSetting` / `resetSetting` / `cleanupBootstrapRow` 的调用方必须传
  `UserActor`；此前经由 shim 接受字符串 ID 的调用点（含测试）改为
  `userActorFromAuthenticatedId(id)`。
- 已部署环境中的 `RUNTIME_JUDGE_MODE` 环境变量会被忽略（无报错）。
- `dev-docs/engineering/route-catalog.md` 已重新生成，不再包含 oi-author 路由。
- 无 schema 变更，不需要迁移。
