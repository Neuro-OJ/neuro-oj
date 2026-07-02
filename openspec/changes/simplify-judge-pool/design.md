## Context

当前 `pool/mod.rs`（~1370 行）是一个功能堆叠的产物：它从最初的固定池逐步叠加了 Scaler 自动扩缩容、Prometheus metrics、Supervisor 一致性检查、leaked_containers 追踪等。在 NOJ 当前阶段（样例题、单 Worker），这些功能从未被真正需要，但使代码难以理解和修改。

核心评测路径（容器复用）本身逻辑清晰，被不必要的抽象层包裹。目标是**削除不可达的复杂度**，保留核心的预热+复用模式，回归一个易于审计和维护的池。

## Goals / Non-Goals

**Goals:**
- 将 pool 模块总代码量从 ~1770 行削减到 ~600 行
- 移除所有已知 Bug（Scaler 的 3 个缺陷、TOCTOU race、容量静默泄漏）
- 清理所有虚假 `#[allow(dead_code)]` 和死代码
- 保留核心功能：预热容器创建、空闲容器复用、健康检查、优雅关闭
- 评测延迟不退化（空闲容器 pop 路径不变）

**Non-Goals:**
- 不改变容器安全配置（cap_drop ALL 等保持不变）
- 不改变 copy.rs / exec.rs / container.rs 的评测执行逻辑
- 不引入新的外部依赖
- 不增加新的环境变量
- 不修改 Redis MQ 协议或评测结果格式

## Decisions

### D1: 移除 Scaler → 固定池大小

**选择**: 用 `min_size` / `max_size` 两个固定常量取代动态 `target_depth`。

**理由**: NOJ 是单 Worker 部署，任务量波动不足以需要自动扩缩容。Scaler 的滑动窗口 QPS 计算有 Bug（arrival timestamp 使用事件创建时间而非任务真正到达时间，分母/窗口口径不一致），修复这些 Bug 的工作量不小，而收益为零。

**备选方案**: 修 Bug 保留 Scaler — 但代码质量收益抵不上维护成本。

**影响**:
- `PoolConfig` 中保留 `min_size` 和 `max_size`（等价于现 `initial_size` 和 `max_size`）
- 移除 `scale_interval_secs`
- 移除 `target_depth`，`set_target_depth()` 方法

### D2: 移除 Prometheus Metrics → 纯日志

**选择**: 删除 `pool/metrics.rs` 和 axum 依赖，池状态通过 tracing 日志输出。

**理由**: 在没有 Prometheus + Grafana 栈的部署中（NOJ 当前状态），metrics 端点从不被消费。保留它增加了 axum 依赖和 ~120 行代码，却从未提供价值。

**备选方案**: 保留但降级为可选（feature gate）— 但这解决不了代码复杂度问题，只是延迟了删除。

**影响**:
- 删除 `Cargo.toml` 中的 `axum` 依赖
- 不再暴露 `/metrics` HTTP 端点
- 池关键状态通过 `info!`/`warn!` 日志输出（Supervisor 的 log_pool_metrics 逻辑保留但简化）

### D3: 简化容器状态机 → 两态

**选择**: `ContainerState` 从 `Idle | InUse | Dead` 简化为 `Idle | InUse`。

**理由**: `Dead` 状态的设计意图是让健康检查和 acquire/release 之间的并发安全——发现异常容器时只标记不立即删除，留给 acquire/release 完成清理。但实际上：
- 所有 Dead 容器的清理都在健康检查的同一轮循环中完成（先 inspect→标记 Dead，紧接着 collect_dead→rm）
- Dead 状态在 acquire 路径中不会被遇到（acquire 只取 Idle）
- 没有跨线程的 Dead 移交逻辑

**新做法**: 健康检查在发现空闲容器异常时**直接 `docker rm -f` + 从队列移除**（合两步为一步），然后检查是否需要回补。这消除了 TOCTOU 的 inspect→标记→清理的时间窗口——因为在 inspect 和清理之间，容器可能被 acquire 走。

**备选方案**: 保留三态但修复 TOCTOU — 修复后的逻辑本质上等同于两步合一步，Dead 状态缺乏存在意义。

### D4: 两路 Acquire → 移除阻塞等待

**选择**: acquire 仅两条路径：① `idle.pop_front()` ② `create_container()`。不阻塞等待。

**理由**: 当前阻塞等待路径仅在 `in_flight >= target_depth` 时触发——即所有容器都在用且已达上限。在简化的固定池中，`max_size` 取代 `target_depth` 作为硬上限。如果到达上限，即时创建路径也创建不了（受限于 max_size），所以阻塞等待理论上可能触发。

但实际上 NOJ 是单 Worker，`max_size` 通常 > 同时评测的任务数。删除阻塞等待消除了 `Notify` 的使用必要性（release 时不需要 notify_one），虽然 `Notify` 本身很轻量，保留也无害。

**影响**: 如果 `in_flight >= max_size` 且 idle 为空，任务报错返回而非阻塞。这种情况仅出现在 max_size 配置极低且突发大量任务时——对 NOJ 当前部署不构成实际问题。

### D5: 简化 Release + 回补

**选择**: release 时总是创建新容器推入 idle，不做 debounce；如果 idle 已满（超过 max_size），跳过回补。

**旧逻辑**:
```
docker rm -f (3 retries) → if success { if idle < target*50% { trigger_replenish } }
                          → if failed { push leaked_containers }
```

**新逻辑**:
```
docker rm -f (3 retries) → create new container → push idle
                          → if idle.len() > max_size { rm oldest idle }
                          → rm fail → log warn (不追踪)
```

**理由**:
- 回补和释放合并为一步——每次用完容器就补一个，保持池大小恒定
- 不需要 debounce（因为不再有多个释放同时触发回补的场景——每个任务独立释放）
- rm -f 失败不再需要 leaked_containers 追踪（健康检查会处理残留容器）

### D6: 清理虚假 dead_code 标记

**选择**: 移除所有 `#[allow(dead_code)]`，对真正不用的代码（`mq::push_result()`）要么删除，要么仅在调用处使用。

**原则**: dead_code 警告是有价值的——它告诉你"有东西没人用了"。全部抑制等于关掉了这个检查。

## Risks / Trade-offs

| 风险 | 缓解 |
|------|------|
| 移除 Metrics 端点后运维可见性下降 | 日志中保留池状态快照（Supervisor 的 log_pool_metrics 逻辑），可通过 `grep` 提取 |
| 阻塞等待移除后，max_size 配太低可能导致任务报错 | 保留 `max_size` 配置，默认 16，远高于单 Worker 并发数 |
| 移除 Per-Image 内存环境变量后，所有镜像共享全局 MEMORY_MB | NOJ 当前仅 `noj-judge-python` 一个镜像，无区分需求 |
| 大重构引入新 Bug | E2E 测试 (`e2e_container_pool`) 覆盖核心路径；重构前后运行对比 |
