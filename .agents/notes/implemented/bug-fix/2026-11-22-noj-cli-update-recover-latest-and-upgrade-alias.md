# Agent Note: 修复 update --latest --recover 误判 no-op 与 upgrade 别名丢弃 --latest

Status: implemented

## Problem

- `update --latest --recover`：迁移阶段失败后 `.env.prod` 已提交为目标版本，
  恢复时 `from === to`，`update`
  走进「已是最新」分支直接返回成功。迁移没有重跑，
  旧服务已被停止、维护模式未退出、checkpoint 仍为未完成，但退出码为 0。
- `upgrade` 别名：接线层与 `upgrade()` 都把 `latest` 强制为 `false`，
  `noj-cli upgrade --latest`
  会按当前版本完整重部署一次（备份、排空、重启）并报告 「生产服务已升级」。这与
  README、函数注释及
  `2026-09-19-noj-cli-update-version-resolution-and-backup-gate` 记录的 「bash
  `update|upgrade)` 共用一个函数」的别名语义相矛盾。

## Decision

- `--latest` 的 no-op 判定增加 `!recovering`：存在未完成 checkpoint 时不得
  no-op， 一律重新执行升级序列。
- 删除 `runProdUpdate` 的 `upgradeAlias` 参数，`update` / `upgrade` 在
  `dispatchProduction` 共用同一个 case；`upgrade()` 直接转发 `update(opts)`。
- 新增回归测试：`--latest --recover` 在 from === to 时必须重跑迁移并把
  checkpoint 推进到 completed；`upgrade` 保留 `--latest`；接线层解析
  `--latest`。 移除旧测试中「upgrade 忽略 --latest」的断言。

## Alternatives considered

- 只改文档声明 `upgrade`
  固定按版本升级：保留两条入口的行为分叉，正是原设计要避免
  的漂移，且静默忽略用户显式传入的旗标。
- 恢复时把 no-op
  改为报错：运维仍需另想办法完成迁移，不如直接重跑幂等的升级序列。

## Consequences

- 恢复未完成升级总会再执行一次备份与升级序列，与固定版本 `--recover`
  既有行为一致（迁移须保持幂等）。
- `upgrade --latest` 现在会真正查询并升级到最新稳定 Release。
