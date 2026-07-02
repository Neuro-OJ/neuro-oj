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
- 不引入新的外部依赖（Redis RPC 客户端复用现有 redis-rs，core 侧复用现有 ioredis）
- 不修改现有的评测任务 MQ 协议

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

### D7: Redis RPC 通信层 — 镜像发现的唯一来源

**选择**: 基于 Redis List 实现轻量 RPC 协议，支持 core↔judge 双向请求/响应。Judge 启动时通过 RPC 从 core 获取镜像列表，`POOL_IMAGES` 环境变量不再使用。RPC 不可用时 judge panic 退出。

**理由**: 
- core 和 judge 之间已经有 Redis 作为通信骨干（MQ），复用同一条连接零额外开销
- RPC 模式比 Pub/Sub 可靠（消息持久化在 List 中），比 Streams 简单（不需要消费组管理），比 HTTP 解耦（无需知道对方地址）
- **无退化路径**: 如果 RPC 不可用，意味着 core 不在线，judge 启动也没有意义（没有 core 就不会有评测任务下发）。panic 即 fail-fast，避免"部分启动"的混淆状态

**备选方案**: HTTP API — 但需要 judge 知道 core 的地址（新环境变量），且需要 core 先启动。

**影响**:
- `POOL_IMAGES` 环境变量**移除**（不再作为退化路径，也不再作为配置项）
- Judge 启动时 `get_image_allowlist()` 失败 → `error!` 日志 + `process::exit(1)`
- 启动顺序：Redis → core → judge（严格的链式依赖）

### Redis RPC 协议设计

#### 命名空间

```
noj:rpc:v1:judge:core           ← List: judge → core 请求
noj:rpc:v1:judge:{id}:response  ← List: core → 指定 judge 的回复
noj:rpc:v1:core:judge           ← List: core → judge 请求
noj:rpc:v1:core:response        ← List: judge → core 回复
```

- `v1` — 版本号，方便未来协议升级
- `{id}` — judge 实例标识（hostname 或 UUID），支持多 judge 实例共存

#### 消息信封

```json
{
  "id": "a1b2c3d4-e5f6-...",
  "method": "get_image_allowlist",
  "params": null,
  "timestamp": 1767312345
}
```

```json
{
  "id": "a1b2c3d4-e5f6-...",
  "result": { "images": ["noj-judge-python"] },
  "error": null,
  "timestamp": 1767312346
}
```

- `id` — UUID，关联请求和回复
- `method` — 方法名（仅请求需要）
- `params` — 请求参数（可选的 JSON）
- `result` — 成功响应数据
- `error` — 错误信息（仅出错时非 null）

#### 请求/响应流程

```
Judge                                 Core
  │                                     │
  │  LPUSH noj:rpc:v1:judge:core        │
  │  ─────────────────────────────────>  │
  │                                     │  BRPOP noj:rpc:v1:judge:core
  │                                     │  → dispatch to handler
  │                                     │  → handler queries DB
  │  BRPOP noj:rpc:v1:judge:{id}:resp   │
  │  <─────────────────────────────────  │  LPUSH noj:rpc:v1:judge:{id}:response
  │                                     │
  │  → parse response                   │
  │  → return typed result              │
```

**超时**: judge 发起请求后最多等待 5s（可配），超时 → `error!` 日志 + `process::exit(1)`。

#### 第一个方法：`get_image_allowlist`

请求（params: null）：

响应（result 结构）：
```json
{
  "result": {
    "images": [
      { "image": "noj-judge-python", "tag": "latest" },
      { "image": "noj-judge-go", "tag": "latest" }
    ]
  }
}
```

Core 侧处理逻辑：查询 `judge_images` 表中所有 `enabled = true` 的记录，返回镜像名列表。

#### 实现约定

- **Judge 侧** (`noj-judge/src/mq/rpc.rs`):
  - `RpcClient` 结构体，封装 Redis connection
  - `request(method, params, timeout) → Result<Value>` 通用方法
  - `get_image_allowlist() → Result<Vec<String>>` 类型安全封装
  - 请求时生成 UUID（`uuid` crate 已有依赖），设置 5s 超时
  - 超时或连接错误 → 返回 Err，调用方 panic 退出

- **Core 侧** (`noj-core/src/mq/judge-rpc.ts`):
  - `JudgeRpcHandler` 类，在已有 Redis consumer 中运行
  - `start() → BRPOP 循环（非阻塞，集成到现有 consumer 的 select! 中）`
  - 收到 `get_image_allowlist` → 从数据库读取 `judge_images` 表 → 返回
  - 未知 method → 返回 `{ error: "unknown method: xxx" }`

## Risks / Trade-offs

| 风险 | 缓解 |
|------|------|
| 移除 Metrics 端点后运维可见性下降 | 日志中保留池状态快照（Supervisor 的 log_pool_metrics 逻辑），可通过 `grep` 提取 |
| 阻塞等待移除后，max_size 配太低可能导致任务报错 | 保留 `max_size` 配置，默认 16，远高于单 Worker 并发数 |
| Redis RPC 请求在 core 启动前发出 → judge panic | 启动顺序要求：Redis → core → judge。如果在容器编排中三者同时启动，judge 可能因竞争条件重启一次。|
| 大重构引入新 Bug | E2E 测试 (`e2e_container_pool`) 覆盖核心路径；重构前后运行对比 |
