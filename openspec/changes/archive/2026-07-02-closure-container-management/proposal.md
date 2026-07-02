## Why

当前 `ContainerGuard`（pool/mod.rs）的 RAII 清理在 `Drop` 中通过 `tokio::spawn` 执行异步 `docker rm -f`，这在运行时 shutdown 时静默丢失清理任务，导致容器泄漏。改用闭包（closure/scope）模式后，容器获取→使用→清理绑定在同一 async 上下文中，消除 spawn 路径的不确定性。

## What Changes

- **新增 `PoolManager::with_container()`** — closure 模式的容器生命周期管理 API（`pool/mod.rs`）
- **移除 `ContainerGuard` 和 `acquire_guarded()`** — 全面删除，不再保留（**BREAKING**）
- **移除裸露的 `acquire()` 方法**（`pool/mod.rs:519`）— 调用方应使用 `with_container()`
- **重构 `evaluate_with_pool()`** — 从 `acquire_guarded()` + `guard.release().await` 改为 `with_container()`
- **新增 `TempDir` RAII Guard** — 临时工作目录的自动清理（sync Drop，可靠）
- **清理 `release()` 文档注释** — 移除"被 ContainerGuard 析构时自动调用"等 Guard 残余描述

## Capabilities

### New Capabilities

（无新能力引入 — 本次变更为现有容器池 API 的改进）

### Modified Capabilities

（无 spec 级行为变更 — 容器池已定义的"容器释放与回补"等功能不变，仅实现路径从 Guard 变为 Closure）

## Impact

- **代码**: `pool/mod.rs` 新增 `with_container()` (~20 行)，删除 `ContainerGuard`（~50 行）和 `acquire_guarded()`；`runner.rs` 的 `evaluate_with_pool()` 从 Guard 改为 Closure 调用
- **新增类型**: `TempDir` guard 在 `sandbox/container.rs`，sync Drop
- **API 兼容**: `acquire_guarded()` 和 `ContainerGuard` 被删除，外部调用者需改用 `with_container()`
- **错误处理**: `with_container()` 在闭包返回后（无论 Ok/Err）执行 `release()`，panic 时仍然丢失（Rust 语言限制，与 Guard 相同）
