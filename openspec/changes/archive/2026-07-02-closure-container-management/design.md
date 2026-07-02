## Context

Semaphore 模式已于 #92 移除，noj-judge 现在仅使用 Pool 模式管理容器。当前容器分配使用 `PoolManager::acquire_guarded()` 返回 `ContainerGuard`，后者在 `evaluate_with_pool` 中通过 `guard.release().await` 释放。Guard 的 `Drop` 实现使用 `tokio::spawn` 作为 fallback，但运行时 shutdown 时 spawn 的 task 可能被静默丢弃。

此变更将容器生命周期管理从 Guard 模式改为 Closure 模式——不存在"释放"操作，只有"用闭包包裹使用范围"。

## Goals / Non-Goals

**Goals:**
- 新增 `PoolManager::with_container()` 闭包 API
- `evaluate_with_pool()` 改用 `with_container()`
- **移除** `ContainerGuard` 和 `acquire_guarded()`（不保留 deprecated 过渡）
- 新增 `TempDir` RAII guard 自动管理临时工作目录

**Non-Goals:**
- 不改变 PoolManager 内部的三阶段获取逻辑（fast/miss/wait）
- 不改变 release() 的 docker rm -f 重试/泄漏追踪逻辑
- 不处理 async Drop（Rust 语言未稳定）
- 不改变 shutdown() 的设计

## Decisions

### Decision 1: `with_container()` 签名设计

```rust
pub async fn with_container<F, Fut, T>(
    self: &Arc<Self>,
    image: &str,
    memory_mb: u64,
    f: F,
) -> Result<T>
where
    F: FnOnce(&str) -> Fut,
    Fut: Future<Output = Result<T>>,
{
    let (id, pool) = self.acquire_with_pool(image, memory_mb).await?;
    let result = f(&id).await;
    self.release(&pool, &id).await;
    result
}
```

**选择理由**: 闭包接收 `&str`（container_id）而非完整 `ContainerGuard`，使调用方无需接触任何生命周期管理逻辑。调用方已有的 `pool: Arc<PoolManager>` 引用可用于 pool 的其他方法（如 `archive_and_copy`）。

### Decision 2: `ContainerGuard` 和 `acquire_guarded()` 全面移除

| 方案 | 评估 |
|------|------|
| **立即删除** | 不影响功能——`evaluate_with_pool` 是唯一的调用方，同步改为 `with_container()` |
| **`#[deprecated]` + 保留** | 无必要——`ContainerGuard` 仅在 noj-judge 内部使用，无外部 API 依赖 |

**选择**: 直接删除整个 `ContainerGuard` struct、其 `impl` 和 `Drop` impl，以及 `acquire_guarded()` 方法。`evaluate_with_pool()` 同步改为 `with_container()`，在同一提交中完成。

### Decision 3: `TempDir` 使用 sync Drop

文件系统操作在 Drop 中使用 `std::fs::remove_dir_all`（同步），这是标准做法（`tempfile` crate 同样如此）。评测工作目录通常 < 100MB，sync Drop 的阻塞时间在可接受范围内。

### Decision 4: Panic 时的清理策略

`with_container()` 在闭包返回后执行 `release()`。如果闭包 panic，release 不会执行——这与当前 Guardian 的 Drop spawn 路径一样会丢失。这是 Rust async/await 中 `catch_unwind` 无法应用于 async fn 的根本限制。

**缓解**: 健康检查的 `cleanup_orphans()` 在下次启动时回收泄漏容器。

## Risks / Trade-offs

- **[低风险] 闭包内持有引用生命周期** — Rust 编译器确保闭包内捕获的引用不短于 `with_container` 的调用栈；避免调用方将容器 ID 泄漏到闭包外
- **[低风险] API 断裂** — `ContainerGuard` 和 `acquire_guarded()` 被移除；经确认它们仅在 noj-judge 内部使用（`evaluate_with_pool`），无外部消费者，风险可控
- **[已知限制] Panic 时容器泄漏** — 与 Guard 模式相同，无新增风险。通过 `cleanup_orphans()` 兜底
