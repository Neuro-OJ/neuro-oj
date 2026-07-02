## 1. 配置简化

- [x] 1.1 从 `PoolConfig` 移除 `scale_interval_secs`、`metrics_bind`、`metrics_auth_token`、`images`（POOL_IMAGES）字段
- [x] 1.2 移除 per-image 内存覆盖解析函数 `memory_mb_for_image()`
- [x] 1.3 移除对应的环境变量读取代码（`POOL_SCALE_INTERVAL`、`METRICS_BIND`、`METRICS_AUTH_TOKEN`、`POOL_MEMORY_MB_*`、`POOL_IMAGES`）
- [x] 1.4 更新 `config.rs` 单元测试：移除 POOL_IMAGES 相关断言

## 2. 池核心重写

- [x] 2.1 重写 `Pool` 结构体：用 `idle: RwLock<VecDeque<String>>` 替代 `containers: RwLock<HashMap<String, ContainerState>>`；添加 `min_size`/`max_size` 固定边界；移除 `target_depth`、`refill_in_progress`
- [x] 2.2 重写 `ContainerState` → 简化为仅 `idle_since: Instant`（无 status 状态机、无 container_id/image 字段）
- [x] 2.3 重写 `Pool::acquire()` → `idle.pop_front()` + `in_flight +1`
- [x] 2.4 重写 `Pool::release()` → 创建新容器 → push idle → 若 `idle.len() > max_size` 则移除最旧
- [x] 2.5 移除 `Pool::collect_dead()`、`collect_idle_timeout()`、`mark_in_use()`、`push_idle()`、`wait_for_slot()`、`set_target_depth()`
- [x] 2.6 重写 `PoolManager::init()`：接受外部传入的镜像列表（不再内部读取 POOL_IMAGES），合并镜像拉取两个分支的重复容器预热代码
- [x] 2.7 重写 `PoolManager::acquire_with_pool()` → 两路路径（pop idle / create 即时创建），移除阻塞等待和 fast scale-up
- [x] 2.8 重写 `PoolManager::release()` → `docker rm -f`（3 次重试）→ 创建新容器 push idle → 失败仅 log warn
- [x] 2.9 移除 `leaked_containers`、`pool_misses_total` 计数器及相关方法
- [x] 2.10 重写健康检查循环 → inspect idle 容器 → 非 running 则直接 rm + 回补；空闲超时清理（仅当 idle.len() > min_size）
- [x] 2.11 合并 Supervisor 到健康检查循环（每 5 次循环输出一次池状态日志）
- [x] 2.12 移除 `scaler_tx`、`send_scaler_event()`、`image_exists_locally()` 中的 race condition 路径（直接尝试 create，失败即 skip）
- [x] 2.13 清理所有 `#[allow(dead_code)]` 注解
- [x] 2.14 将 `Pool::notify` 可见性改为 `pub(crate)`

## 3. 删除文件

- [x] 3.1 删除 `pool/scaler.rs`
- [x] 3.2 删除 `pool/metrics.rs`
- [x] 3.3 从 `pool/mod.rs` 移除 `pub mod scaler;` 和 `pub mod metrics;`

## 4. 入口和模块导出更新

- [x] 4.1 更新 `main.rs`：移除 `pool.start_scaler()` 和 `pool.start_metrics_server()` 调用；移除 `ScalerEvent` import
- [x] 4.2 更新 `main.rs`：移除 `pool_misses_total` 计数器递增
- [x] 4.3 更新 `lib.rs`：移除 `pub mod scaler` 和 `pub mod metrics` 导出（若存在）
- [x] 4.4 检查 `Cargo.toml`：若 axum 不再被其他模块引用，移除 axum 依赖；新增 gethostname 依赖
- [x] 4.5 删除 `mq.rs` 中未使用的 `push_result()` 函数

## 5. Redis RPC 通信层

- [x] 5.1 定义 Redis RPC 协议规范文档（已在 design.md 和 specs/judge-rpc/spec.md 中完成）
- [x] 5.2 在 `Cargo.toml` 新增 `gethostname` 依赖
- [x] 5.3 实现 Judge 侧 `RpcClient`（`noj-judge/src/mq/rpc.rs`）
- [x] 5.4 实现 Core 侧 `JudgeRpcHandler`（`noj-core/src/mq/judge-rpc.ts`）
- [x] 5.5 集成到 Judge `main.rs`：启动时通过 RPC 获取镜像列表 → 失败时 exit(1)
- [x] 5.6 集成到 Core `main.ts`：在 Redis 就绪后启动 RPC handler

## 6. 文档更新

- [x] 6.1 更新 `noj-judge/AGENTS.md`：移除"双运行模式"、"Semaphore 模式"、"RAII Guard"引用
- [x] 6.2 更新 AGENTS.md 中所有过时的函数名（`acquire_guarded` → `with_container`）
- [x] 6.3 更新 AGENTS.md 中的常量值（`RM_F_RETRY_DELAYS` 等）
- [x] 6.4 更新 AGENTS.md 中的环境变量表（移除 `POOL_SCALE_INTERVAL`、`METRICS_BIND`、`METRICS_AUTH_TOKEN`）
- [x] 6.5 更新 AGENTS.md 中的 Metrics 端点表 → 替换为日志输出说明
- [x] 6.6 更新 AGENTS.md 中的 Scaler 算法章节 → 移除
- [x] 6.7 更新 `noj-core/AGENTS.md`：添加 RPC handler 说明和 Redis key 命名约定
- [x] 6.8 更新 `noj-judge/AGENTS.md`：添加 Redis RPC 客户端说明和镜像发现流程

## 7. 测试更新

- [ ] 7.1 更新 `e2e_container_pool.rs`：移除 Scaler 行为断言、Metrics 端点测试（需 Docker 环境，手动执行）
- [ ] 7.2 添加简化池逻辑的单元测试：idle 队列 FIFO 语义、min/max 边界、健康检查逻辑
- [x] 7.3 运行 `cargo test --lib` — 44/44 通过，0 失败
- [ ] 7.4 运行 `NOJ_RUN_E2E=1 cargo test --test e2e_container_pool -- --ignored`（需 Docker 环境，手动执行）

## 8. 验证

- [x] 8.1 `cargo fmt` 格式化
- [x] 8.2 `cargo clippy` — 0 warnings
- [x] 8.3 `cargo build` — 编译成功
- [ ] 8.4 确认 noj-judge 启动不报错（需 Docker + Redis 环境，手动验证）
