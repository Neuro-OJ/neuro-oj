## Why

当前 noj-judge 容器池模块 (`pool/`) 过度复杂：~1370 行代码包含自动扩缩容（Scaler）、Prometheus 指标暴露、Supervisor 一致性检查等功能，其中 Scaler 存在 3 个已知 Bug（QPS 计算偏差、时间戳失真、sample_count 设计缺陷）。在 NOJ 当前规模下（样例题、单 Worker），这些功能从未被需要，却显著增加了维护成本。代码中还残留大量 `#[allow(dead_code)]` 标记和 ~60 行重复代码，CLAUDE.md 文档严重过时（引用已删除的 Semaphore 模式和不存在的 `acquire_guarded` API）。简化池架构将大幅降低维护负担，同时保留核心功能（预热容器 + 复用）不退化。

## What Changes

- **删除** Scaler 自动扩缩容模块 (`pool/scaler.rs`)，移除滑动窗口 QPS/排队/Miss 率计算
- **删除** Prometheus Metrics 端点 (`pool/metrics.rs`)，移除 axum HTTP 依赖
- **删除** Supervisor 后台任务（30s 一致性检查），保留基本的池状态日志
- **简化** 容器状态机：移除 `Dead` 状态，仅保留 `Idle` / `InUse`
- **简化** acquire 路径：从三路（空闲取/即时创建/阻塞等待）简化为两路（空闲取/即时创建），移除阻塞等待
- **简化** release 路径：移除 leaked_containers 追踪、refill debounce 机制；rm -f 失败仅记录日志
- **移除** 快速扩容（fast scale-up）：不再在 miss 时递增 target_depth
- **移除** `target_depth` 概念：代之以固定 `min_size` / `max_size` 边界
- **移除** Per-Image 内存覆盖环境变量 (`POOL_MEMORY_MB_*`)
- **移除** `POOL_SCALE_INTERVAL`、`METRICS_BIND`、`METRICS_AUTH_TOKEN` 配置项
- **清理** 死代码：`mq::push_result()`、所有虚假的 `#[allow(dead_code)]` 注解
- **更新** CLAUDE.md：移除所有过时引用（双模式、Semaphore、RAII Guard、acquire_guarded），对齐实际实现
- **合并** `PoolManager::init()` 中 ~60 行重复的容器预热代码
- **BREAKING**: 移除 Prometheus metrics 端点；移除 `POOL_MEMORY_MB_*` 环境变量支持

## Capabilities

### New Capabilities
<!-- None needed — this is a simplification, not new functionality -->

### Modified Capabilities

- `container-pool`: 移除自动扩缩容需求，简化容器分配/释放/健康检查/可观测性规范，移除 Per-Image 资源配置
- `judge-worker`: 移除对动态 target_depth 和自动扩缩容的引用

## Impact

- **代码**: `pool/mod.rs` (~1370→~500 行), `pool/scaler.rs` (删除), `pool/metrics.rs` (删除), `config.rs` (移除无用字段), `main.rs` (移除后台任务启动), `lib.rs` (移除模块导出), `Cargo.toml` (移除 axum)
- **配置**: `POOL_SCALE_INTERVAL`, `METRICS_BIND`, `METRICS_AUTH_TOKEN`, `POOL_MEMORY_MB_*` 不再支持
- **运维**: Prometheus /metrics 端点不可用；基本日志 (`info!`/`warn!`) 仍保留
- **性能**: 评测延迟不变（核心路径：预热容器复用保留）；冷启动创建容器延迟与原来相同
- **测试**: E2E 池测试需更新（移除 metrics 断言、scaler 行为验证）；单元测试新增池简化逻辑覆盖
