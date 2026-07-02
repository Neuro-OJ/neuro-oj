## Why

noj-judge 目前维护两套并行的评测运行模式：默认的容器池（Pool）模式和传统的 Semaphore 模式。Pool 模式已经过充分的生产验证并默认启用，Semaphore 模式作为迁移过渡方案已无继续维护的必要。移除 Semaphore 模式可以消除约 200 行冗余代码、一个已知的容器泄漏 bug、一个多余的环境变量，并简化测试矩阵。

## What Changes

- **移除 Semaphore 模式入口分支** — `main.rs` 中的 `if config.pool.enabled { ... } else { ... }` 仅保留 Pool 分支
- **移除 `evaluate_legacy()`** — `judge/runner.rs` 中基于 Semaphore 的评测函数
- **移除 `run_in_container()` 及相关函数** — `sandbox/container.rs` 中 Semaphore 专属的容器生命周期管理（`run_in_container`、`ensure_image_local`、`capture_container_logs`），保留公共工具函数（`prepare_work_dir`、`extract_zip`、`write_user_code`、`parse_command`）
- **移除 `MAX_CONCURRENT` 环境变量** — 简化为仅 `POOL_MAX_SIZE` 控制并发上限；`POOL_ENABLED` 环境变量一并移除
- **清理 spec 文档** — 更新 `container-pool` spec 中与池禁用/Semaphore 回退相关的场景描述

## Capabilities

### New Capabilities

（无新能力引入，本次变更为纯粹的代码移除和清理）

### Modified Capabilities

- `container-pool`: 移除"池禁用"相关场景（Semaphore 回退路径），所有容器管理强制通过 PoolManager
- `docker-sandbox`: 移除对 Semaphore 模式下 `run_in_container` 的引用；简化容器创建路径的描述
- `judge-worker`: 移除 `POOL_ENABLED` / `MAX_CONCURRENT` 环境变量的引用

## Impact

- **代码**: `main.rs` (~70 行)、`runner.rs` (~20 行)、`container.rs` (~160 行) 中约 200 行代码移除
- **环境变量**: `POOL_ENABLED` 和 `MAX_CONCURRENT` 不再生效；已配置 `POOL_ENABLED=false` 的环境需移除该变量或不做任何事（无影响），已配置 `MAX_CONCURRENT` 的环境需改用 `POOL_MAX_SIZE`
- **Bug 修复**: `container.rs` 超时路径的 `remove_container` 遗漏随 `run_in_container` 移除而消除
- **测试**: 移除 `evaluate_legacy` 相关的 E2E 测试用例；池模式的现有 E2E 测试保持不变
