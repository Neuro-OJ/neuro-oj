## Context

noj-judge 当前在 `main.rs` 中通过 `POOL_ENABLED` 环境变量分支为两条独立的执行路径：

1. **容器池（Pool）模式**（默认）— `PoolManager` 预创建容器，`evaluate_with_pool()` 执行
2. **Semaphore 模式**（legacy）— Tokio `Semaphore` 控制并发，每次任务 `create_container` → `run` → `remove_container`

两个模式共享 `mq.rs`（Redis MQ）、`types.rs`（数据结构）和 `sandbox/container.rs` 中的工具函数（zip 解压、命令解析等），但容器生命周期管理和评测执行逻辑完全独立。

Issue #92 要求在完成 #91（closure 化容器管理）之前先行移除 Semaphore 模式，使架构收束为单一路径后再进行内部重构。

## Goals / Non-Goals

**Goals:**
- 移除 `main.rs` 中的 Semaphore 分支，`main()` 始终走 Pool 路径
- 移除 `judge/runner.rs` 中的 `evaluate_legacy()`
- 移除 `sandbox/container.rs` 中 Semaphore 独占的函数（`run_in_container`、`ensure_image_local`、`capture_container_logs`），保留公共工具函数
- 移除 `config.rs` 中的 `MAX_CONCURRENT` 环境变量和 `POOL_ENABLED` 配置项
- 保持 Pool 模式的全部功能不变，现有测试零失败
- 更新 `container-pool`、`docker-sandbox`、`judge-worker` 三个 spec 中与 Semaphore 模式相关的描述

**Non-Goals:**
- 不改变 Pool 模式内部的容器管理逻辑（`PoolManager`、`ContainerGuard` 等保持原样）
- 不涉及 noj-core、noj-ui 或其他模块的变更
- 不处理 `sandbox/container.rs` 中 `capture_container_logs` 是否应被 Pool 模式复用的评估（已有 `pool/exec.rs` 处理日志捕获）

## Decisions

### Decision 1: `POOL_ENABLED` 彻底移除而非忽略

| 方案 | 评估 |
|------|------|
| **保留 `POOL_ENABLED` 但固定为 true** | 减少配置断裂，但残留无用代码，混淆用户 |
| **彻底移除** | 配置不兼容但干净，用户需清理 `.env` |

**选择**: 彻底移除。`PoolConfig::from_env()` 中不再读取 `POOL_ENABLED`。配置了 `POOL_ENABLED=false` 的环境在升级后会忽略此变量（无错误，仅日志提示未使用），无需 crash。

### Decision 2: `sandbox/container.rs` 保留为公共工具模块

`run_in_container` 被移除后，`container.rs` 中仍有以下函数被 Pool 模式使用：

| 函数 | 使用方 |
|------|--------|
| `prepare_work_dir()` | `judge/runner.rs:evaluate_with_pool` |
| `get_support_package_bytes()` | `judge/runner.rs:do_evaluate_with_pool` |
| `extract_zip()` | `judge/runner.rs:do_evaluate_with_pool` |
| `write_user_code()` | `judge/runner.rs:do_evaluate_with_pool` |
| `parse_command()` | `judge/runner.rs:do_evaluate_with_pool` |
| `ContainerOutput` | `judge/runner.rs:process_output` |

因此保留 `container.rs`，更名为"工具库"定位。模块注释从"容器生命周期"更新为"评测工具函数"。

### Decision 3: `max_concurrent()` 简化为直接返回 `pool.max_size`

当前 `Config::max_concurrent()` 在 Pool 模式下返回 `pool.max_size`，Semaphore 模式下读取 `MAX_CONCURRENT`。移除 Semaphore 后此函数退化为单路径，改为直接返回 `pool.max_size`，并用 `#[inline]` 标注。

### Decision 4: 测试采取移除而非屏蔽

`evaluate_legacy` 的测试（如存在）应**直接移除**而非 `#[ignore]`，因为不存在回退场景。Pool 模式的 E2E 测试保持不变（`e2e_container_pool.rs` 等已覆盖）。

## Risks / Trade-offs

- **[低风险] 环境变量 `POOL_ENABLED=false` 的存量配置静默失效** → 用户不会收到错误，但环境变量不再生效。通过 `tracing::warn!` 在启动时检测 `POOL_ENABLED` 被设置但被忽略的情况，提示用户移除。
- **[低风险] `MAX_CONCURRENT` 用户需迁移到 `POOL_MAX_SIZE`** → 竞品行为不同（`MAX_CONCURRENT` 仅在 Semaphore 模式下生效），影响面小。在 release note 中标注。
- **[低风险] 移除了 `ensure_image_local()` 中镜像不存在的友好错误提示** → Pool 模式在 `PoolManager::init()` 中已有镜像检查，缺失时的错误信息不如 `ensure_image_local` 详细。在 `PoolManager::init()` 中增强镜像缺失的错误提示以弥补。
