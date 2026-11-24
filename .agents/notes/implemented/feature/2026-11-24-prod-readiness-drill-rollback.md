# Agent Note: 生产压测演练、沙箱对抗测试与一键回滚基线

Status: implemented

## Problem

Neuro OJ 在正式承担公开模拟赛与线上认证评测前，仍缺少高并发压测与混沌排空验证工具、深度沙箱逃逸与资源炸弹对抗用例，以及版本升级异常后的 `noj-cli` 一键回滚能力。

## Decision

1. **`noj-judge` 沙箱加固与对抗矩阵**：
   - 在 `src/sandbox/container.rs` 补充符号链接条目、NUL 字节与反斜杠开头路径穿越拦截。
   - 在 `tests/e2e_security_isolation.rs` 补充 fork 炸弹（`pids_limit`）、cgroup OOM、readonly rootfs、Capabilities 清零与 `no-new-privileges` 对抗测试，以及非 ignore 网络白名单与安全基线单测。
2. **`noj-tests/stress/` 压测与混沌演练套件**：
   - 新增 `contest-load-test.ts`（AI/OI 混合负载、`4:2:1` 优先级公平性与 429/503 背压统计，支持 `--dry-run` 与 `--live`）与 `chaos-drain-verify.ts`（对齐 Redis 队列布局验证中断排空与 Sweeper 重投）。
3. **`noj-cli` 一键回滚（`rollback`）**：
   - 新增 `src/prod/lifecycle/rollback.ts` 与 `src/prod/commands/rollback.ts`，支持 `--to`、`--restore-backup`、`--force-app-only` 与 `--dry-run`；检测到存在跨版本数据库迁移时默认拒绝单纯回切应用版本，强制要求显式指定恢复方式。
4. **演练手册**：
   - 新增 `noj-docs/docs/operators/contest-readiness-drill.md`，对接 `deploy/monitoring/noj-alerts.yml` 形成赛前/赛时/赛后 SOP。

## Alternatives considered

- **在回滚时默认自动还原备份**：可能意外覆盖升级后新产生的提交记录，因此默认启用迁移探测守卫，由运营者显式选择 `--restore-backup` 或 `--force-app-only`。

## Consequences

- `noj-cli` 运维工具链覆盖安装、升级、备份与回滚完整闭环。
- 面向公开模拟赛前需在 Linux + Docker 环境执行 `NOJ_RUN_E2E=1` 与真实 staging `--live` 压测，采集硬件级基线指标。
