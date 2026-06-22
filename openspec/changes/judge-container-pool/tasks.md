## 1. 配置层

- [x] 1.1 在 `config.rs` 移除 `MAX_CONCURRENT`；新增 `PoolConfig` 结构体，包含全部新环境变量：`POOL_ENABLED`, `POOL_INITIAL_SIZE`, `POOL_MAX_SIZE`, `POOL_MIN_SIZE`, `POOL_MEMORY_MB`, `POOL_CPU`, `POOL_IMAGES`, `POOL_IDLE_TIMEOUT`, `POOL_SCALE_INTERVAL`, `POOL_MAX_ARCHIVE_MB`，全部使用 `unwrap_or_else` 默认值
- [x] 1.2 在 `config.rs` 添加一个 `legacy` 开关：`POOL_ENABLED=false` 时回退到原有 Semaphore + `MAX_CONCURRENT` 模型，保持向后兼容

## 2. Pool 核心模块（`src/pool/mod.rs`）

- [x] 2.1 创建 `PoolManager` 结构体：包含 `per-image: HashMap<String, Pool>`、`in_flight: AtomicUsize`、`target_depth: AtomicUsize`、`max_depth: usize`、`shutdown_token: CancellationToken`
- [x] 2.2 创建 `Pool` 结构体：`idle: Mutex<VecDeque<ContainerState>>`、`notify: tokio::sync::Notify`（用于队列等待通知）
- [x] 2.3 实现 `PoolManager::init()`：遍历 `POOL_IMAGES`，逐个 `docker pull`（含 3 次重试），创建 `POOL_INITIAL_SIZE` 个容器，启动后放入空闲队列
- [x] 2.4 实现 `PoolManager::acquire(image, memory_mb) -> Result<ContainerGuard>`：从空闲队列 pop 或即时创建新容器，调用 `docker.update_memory()`，返回 RAII guard（析构时自动 `docker rm -f` + `in_flight--` + 触发回补检查）
- [x] 2.5 实现 `acquire` 的阻塞等待逻辑：空闲队列空且 `in_flight >= max_depth` 时，等待 `notify.notified()`
- [x] 2.6 实现 `PoolManager::release(container_id)`：被 `ContainerGuard` 析构调用：`docker rm -f` → `in_flight--` → `notify.notify_one()` → 检查是否需回补
- [x] 2.7 回补逻辑：若空闲队列长度 < target_depth 的 50%，spawn 后台任务创建一新容器推入队列
- [ ] 2.8 镜像名称归一化匹配：acquire 时 strip 默认 `:latest` tag 再匹配池注册名（待实现）

## 3. 容器文件注入（`src/pool/copy.rs`）

- [x] 3.1 实现 `archive_work_dir(work_dir) -> Vec<u8>`：使用 `tar` crate 将目录打包为内存字节流
- [x] 3.2 安全过滤：打包时跳过符号链接（`is_symlink`）和含 `..` 的条目；若总大小超 `POOL_MAX_ARCHIVE_MB` 返回错误
- [x] 3.3 实现 `copy_to_container(docker, container_id, tar_bytes)`：通过 bollard `put_archive` API 上传到容器 `/tmp/`

## 4. 容器执行（`src/pool/exec.rs`）

- [x] 4.1 实现 `execute_in_container(docker, container_id, judge_command, timeout_ms)`：通过 bollard exec API 执行命令，流式捕获 stdout/stderr
- [x] 4.2 超时处理：`tokio::select!` 竞速 exec stream 与 `tokio::time::sleep`；超时先 `docker stop -t 2` 再 `docker kill`
- [ ] 4.3 集成标准输出解析：复用 `runner.rs` 中 `process_output()` 处理捕获到的 stdout/stderr，复用现有 `---RESULT---` 标记解析（任务 6 集成时完成）

## 5. 公共函数重构（`src/sandbox/container.rs`）

- [x] 5.1 提取 `prepare_work_dir(submission_id, support_package, code, file_name)`：创建临时目录、解码 Base64、解压 zip 保护（过滤 `..` 路径）、写用户代码；返回 work_dir 路径（已在 sandbox/container.rs 中 pub）
- [x] 5.2 提取 `parse_log_output(stdout, stderr, exit_code)`：通用的退出码和日志解析逻辑，返回 JudgeResult 的 status/score/details（已复用 runner.rs process_output）
- [x] 5.3 保留 `run_in_container()` 作为 `POOL_ENABLED=false` 时的回退路径，内部调用提取后的公共函数

## 6. 评测编排适配（`src/judge/runner.rs`）

- [x] 6.1 `evaluate()` 函数重写：添加 `evaluate_with_pool()` 使用池路径 + `evaluate_legacy()` 保留旧路径
- [ ] 6.2 `ContainerGuard` RAII 自动释放（当前使用手动 release 调用，后续可优化）
- [x] 6.3 `POOL_ENABLED=false` 时走旧路径：`evaluate_legacy()` → `run_in_container()`

## 7. 主循环集成（`src/main.rs`）

- [x] 7.1 移除现有的 `Semaphore::new(MAX_CONCURRENT)` 初始化（已整合到两个分支中）
- [x] 7.2 启动时初始化 `PoolManager`（`POOL_ENABLED=true`）或不初始化（`POOL_ENABLED=false` → 用旧 Semaphore 模型）
- [x] 7.3 主循环 `loop { task = pull → pool.acquire() → evaluate() → guard 自动释放 }`，不再手动管理 permit
- [x] 7.4 注册 SIGTERM 信号处理：设置 `shutdown_token`，调用 `PoolManager::shutdown()`

## 8. 自动扩缩容（`src/pool/scaler.rs`）

- [x] 8.1 创建 `Scaler` 结构体：维护滑动窗口指标，每 `POOL_SCALE_INTERVAL` 秒采样一次
- [x] 8.2 实现 `Scaler::record_arrival()`：任务到达时记录时间戳
- [x] 8.3 实现 `Scaler::record_queue_wait(duration)`：acquire 成功时记录排队耗时
- [x] 8.4 实现 `Scaler::adjust_target(pool)`：按算法计算 new_target，执行 `pool.set_target_depth(new_target)`
- [x] 8.5 实现 `PoolManager::set_target_depth(n)`：增加目标 → 创建新容器补齐；降低目标 → 从空闲队列尾部移除多余容器

## 9. 健康检查（`src/pool/mod.rs` 内）

- [x] 9.1 实现 `health_check_loop(pool_manager)`：每 5 秒遍历所有池中空闲容器，`docker inspect` 检查状态
- [x] 9.2 异常容器移除：非 running 容器标记 Dead 并由后续流程清理回补
- [x] 9.3 空闲超时清理：记录每个容器入队时间戳，超 `POOL_IDLE_TIMEOUT` 的移除不回补

## 10. 优雅关闭

- [x] 10.1 实现 `PoolManager::shutdown()`：设置关闭标志 → 通知所有 acquire waiter → CancellationToken 取消回补

## 11. E2E 测试

- [ ] 11.1 创建 `tests/e2e_container_pool.rs`
- [ ] 11.2 测试启动时初始池创建（验证 `POOL_INITIAL_SIZE` 个容器已运行）
- [ ] 11.3 测试完整执行路径（acquire → docker update → put_archive → exec → rm → 回补）
- [ ] 11.4 测试达上限时排队等待（提交 `POOL_MAX_SIZE + 1` 个并发任务，验证排队行为）
- [ ] 11.5 测试动态内存调整（验证 exec 前容器 memory cgroup 已更新为 task 值）
- [ ] 11.6 测试 exec 超时（提交会超时的代码，验证 `stop -t 2` + `kill` 及 TimeLimitExceeded）
- [ ] 11.7 测试空闲超时清理（等待超过 POOL_IDLE_TIMEOUT，验证容器被移除且不回补）
- [ ] 11.8 测试健康检查（手动停止一个池中容器，验证 5s 内检测到并回补）
- [ ] 11.9 测试优雅关闭（发送 SIGTERM，验证 inflight 完成且空闲容器被清理）
- [ ] 11.10 测试镜像预拉取失败（配置不存在的镜像，验证系统不阻塞）
- [ ] 11.11 测试 tar 安全过滤（支持包含符号链接，验证跳过且不影响任务结果）
- [ ] 11.12 测试 `POOL_ENABLED=false` 向后兼容（验证走旧 Semaphore + run_in_container 路径）
- [ ] 11.13 测试容器安全配置（验证已创建容器的 CapDrop/AppArmor/ReadonlyRootfs 正确）
- [ ] 11.14 测试熔断降级（模拟 Docker daemon 不可用，验证自动切旧模式）
- [ ] 11.15 测试孤儿容器清理（模拟 SIGKILL 后重启，验证残留被清除）
- [ ] 11.16 测试 rm -f 重试（模拟 rm 失败，验证重试和泄漏追踪）
- [ ] 11.17 测试 zip 完整性防护（恶意 zip 含 overlapping entries，验证被拒绝）

## 12. 安全加固

- [x] 12.1 容器创建时配置 `CapDrop=["ALL"]`, `SecurityOpt=["no-new-privileges"]`, `ReadonlyRootfs=true`, `NetworkMode="none"`（已在 PoolManager::create_container_inner 中实现）
- [x] 12.2 docker update 时同步设置 MemorySwap = task.memory_limit_mb, MemorySwappiness = 0（已在 update_container_memory 中实现）
- [ ] 12.3 zip 解压增加 overlapping entries 检测和总大小限制（修改 `prepare_work_dir` 中的解压逻辑）

## 13. 并发安全

- [x] 13.1 引入容器状态枚举：`enum ContainerState { Idle, InUse, Removing, Dead }`（已在 pool/mod.rs 中实现）
- [x] 13.2 空闲队列从 VecDeque 升级为 `Mutex<RwLock<HashMap<String, ContainerState>>>`（已在 Pool 结构体中实现）
- [x] 13.3 acquire 原子性检查 Idle → InUse；health_check 标记 Dead 不移除；release 处理 Dead 容器的移除（已在 pool/mod.rs 中实现）
- [ ] 13.4 回补请求添加 200ms debounce（AtomicBool 标记 + tokio::time::sleep 合并窗口）
- [ ] 13.5 实现 Supervisor 后台任务（30s 周期，检查 health_check/scaler/replenish 任务存活，崩溃后自动重启）

## 14. 可靠性和熔断

- [x] 14.1 创建 `with_timeout(duration, api_call)` 包装函数，对所有 bollard API 调用应用超时
- [ ] 14.2 实现熔断器：AtomicBool 状态 + 30s 滑动窗口错误计数，错误率 >50% 时自动切旧模式
- [ ] 14.3 实现 Docker 恢复探测：熔断后每 30s 尝试 `docker.ping()`，成功后自动切回池模式
- [ ] 14.4 `release` 中 docker rm -f 退避重试 3 次（100ms, 500ms, 2s），全部失败加入泄漏追踪列表
- [x] 14.5 启动时根据标签清理孤儿容器（PoolManager::init 中先 docker ps --filter label=com.noj.judge.pool=true 再 rm -f）
- [x] 14.6 冷启动策略：前 2 个 POOL_SCALE_INTERVAL 仅扩不缩，初始 target_depth = POOL_INITIAL_SIZE + 1（已在 Scaler 中实现）

## 15. 可观测性

- [ ] 15.1 在 pool 模块注册 Prometheus 指标：pool_idle_containers, pool_in_flight, pool_queue_wait_seconds, pool_miss_total, pool_target_depth, pool_scale_actions, pool_leaked_containers, pool_bollard_errors
- [ ] 15.2 暴露 `/metrics` HTTP 端点（复用或新增 noj-judge 的 HTTP 服务）
- [ ] 15.3 Scaler 每次调整输出结构化日志包含完整决策上下文（target_depth, metrics, action）
- [ ] 15.4 所有后台任务错误输出结构化 ERROR 日志（含 task id, 错误类型, 上下文）

## 16. Per-Image 配置

- [ ] 16.1 配置加载时支持 `POOL_MEMORY_MB_{IMAGE_NAME}` 模式，按镜像名归一化后查找并覆盖全局值
- [ ] 16.2 不同镜像维护独立的 Pool 实例（含独立 memory_mb 上限）
