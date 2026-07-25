# container-pool 主规范 — 已归档（2026-07-25）

本目录原为主规范 `openspec/specs/container-pool/spec.md` 的归档位置。

## 归档缘由

`container-pool` 主规范描述的 PoolManager 容器池行为（含固定池大小、
统一容器池管理、容器分配两路 Acquire、容器释放与自动回补、健康检查、
文件注入 docker cp、评测执行 docker exec、优雅关闭、容器安全加固、
并发安全与状态管理、可靠性与故障恢复、zip 完整性校验等 11 个 Requirements）

已被 OpenSpec 变更 `remove-single-container-mode`（合并到
`2026-07-25-remove-single-container-mode` 归档目录）撤销。

具体撤销动作：

- 删除整个 `noj-judge/src/pool/` 模块（PoolManager、懒回补、健康检查、文件注入）
- 移除 `JudgeMode::Single` 枚举分支
- 移除 `JudgeTask` 上的 `mode` / `judge_image` / `judge_command` 字段
- 移除 `problems` 表的 `judge_image` / `judge_command` 列
- 清理 `POOL_INITIAL_SIZE` / `POOL_MAX_SIZE` / `POOL_MIN_SIZE` /
  `POOL_IDLE_TIMEOUT` / `POOL_LABEL_PREFIX` / `POOL_MAX_ARCHIVE_MB` 等环境变量
  （保留 `POOL_MEMORY_MB` / `POOL_CPU` / `POOL_KILL_GRACE_SECONDS`，因双容器路径仍使用）
- 修复 rejudge 路径缺少 `runtime_config` 的 regression

## 当前实现

所有评测统一走 `dual::evaluate_dual()` 路径，由主规范 `judge-worker` 中的 ADDED
Requirements（特别是"双容器评测编排（dual mode）"与"容器清理 RAII 契约"）描述。

zip 完整性校验的多层防护（解压大小限制、overlapping entry 拒绝、`..` 路径拒绝、
单文件大小限制）已迁移至 `judge-worker` 主规范的 `Requirement: 评测编排`
`Scenario: zip 解压防护`。

## 归档日期

2026-07-25（与 `add-noj-docs`、`dual-container-judge`、
`remove-single-container-mode` 三个变更同期归档）。