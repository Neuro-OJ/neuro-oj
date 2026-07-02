## ADDED Requirements

### Requirement: 固定池大小

系统 SHALL 使用固定的最小/最大池大小，不再支持动态调整 target_depth。

#### Scenario: 池大小边界固定

- **WHEN** noj-judge 运行中
- **THEN** 池容器数始终在 `[POOL_MIN_SIZE, POOL_MAX_SIZE]` 范围内
- **THEN** 系统不根据 QPS、排队时间或空闲率调整池大小

## MODIFIED Requirements

### Requirement: 统一容器池管理

系统 SHALL 使用 PoolManager 对所有评测容器进行统一管理。

#### Scenario: 启动时创建初始池

- **WHEN** noj-judge 启动
- **THEN** 系统通过 Redis RPC 向 core 请求镜像白名单（`get_image_allowlist` 方法）
- **THEN** 若 RPC 失败或超时，系统记录 `error!` 日志并调用 `process::exit(1)` 退出
- **THEN** 对返回列表中的每个镜像检查本地是否存在（若不存在则 docker pull，失败重试 3 次，间隔 5s）
- **THEN** 若镜像已在本地存在，跳过拉取
- **THEN** 每个镜像创建 `POOL_INITIAL_SIZE` 个容器，CMD 设为 `sleep infinity`
- **THEN** 容器全部就绪后，主循环开始从 MQ 拉取任务

#### Scenario: 启动时预拉取镜像失败

- **WHEN** 对某个镜像的 `docker pull` 经过 3 次重试仍失败
- **THEN** 系统记录 `warn!` 日志跳过该镜像
- **THEN** 该镜像的池维持为空，系统正常启动，任务通过即时创建路径执行

### Requirement: 容器分配（两路 Acquire）

系统 SHALL 从池中分配空闲容器执行评测。无空闲容器时即时创建。

#### Scenario: 有空闲容器

- **WHEN** 评测任务到达
- **THEN** 系统根据 `task.judge_image` 查找对应镜像的空闲容器队列
- **THEN** 若队列非空，取出一个容器，`in_flight` 计数器 +1
- **THEN** 系统执行文件注入和评测命令

#### Scenario: 无空闲容器时即时创建

- **WHEN** 空闲队列为空
- **THEN** 系统立即创建一个新容器（CMD = `sleep infinity`，安全配置同预热容器）
- **THEN** 该容器直接分配给当前任务
- **THEN** `in_flight` 计数器 +1

#### Scenario: 镜像名匹配

- **WHEN** 系统按 `task.judge_image` 查找池
- **THEN** 若池中存在 image 且 task.judge_image 与池注册镜像名在去除默认 tag（`:latest` 视为等价于无 tag）后一致，视为匹配
- **THEN** 若无匹配池，系统自动创建新池并即时创建容器

### Requirement: 容器释放与自动回补

系统 SHALL 在任务完成后删除容器并创建新容器回补到空闲队列。

#### Scenario: 任务完成释放

- **WHEN** 评测任务完成（成功或失败）
- **THEN** `in_flight` 计数器 -1
- **THEN** 系统执行 `docker rm -f` 删除容器（首次失败后退避重试 3 次：100ms / 500ms / 2s）
- **THEN** 系统创建新容器并推入对应镜像的空闲队列
- **THEN** 若空闲队列长度超过 `POOL_MAX_SIZE`，移除最旧的空闲容器（`docker rm -f`）

#### Scenario: rm -f 重试全部失败

- **WHEN** `docker rm -f` 3 次重试全部失败
- **THEN** 系统记录 `error!` 日志（含 container_id 和 image）
- **THEN** 系统不追踪泄漏容器，依赖启动时孤儿清理处理

### Requirement: 健康检查

系统 SHALL 定期检查池内空闲容器的健康状态，直接移除异常容器并回补。

#### Scenario: 空闲容器异常

- **WHEN** 健康检查（每 5s）对空闲容器执行 inspect 发现容器非 running
- **THEN** 系统直接执行 `docker rm -f` 删除该容器
- **THEN** 系统从空闲队列移除该容器条目
- **THEN** 系统检查空闲队列长度，若低于 `POOL_MIN_SIZE` 则创建新容器回补

#### Scenario: 空闲超时清理

- **WHEN** 容器在空闲队列中停留时间超过 `POOL_IDLE_TIMEOUT` 秒且空闲队列长度 > `POOL_MIN_SIZE`
- **THEN** 系统移除并 `docker rm -f` 删除该容器
- **THEN** 不触发回补

### Requirement: 优雅关闭

系统 SHALL 在 SIGTERM 时按顺序关闭：停止拉取 → inflight 完成 → 清理池。

#### Scenario: 收到 SIGTERM

- **WHEN** noj-judge 收到 SIGTERM
- **THEN** 主循环停止拉取新任务
- **THEN** 设置 `shutting_down` 标记阻止新容器创建
- **THEN** 等待所有 inflight 任务完成（最长 30s 超时）
- **THEN** 对所有池中容器执行 `docker rm -f`

### Requirement: 并发安全与状态管理

系统 SHALL 使用简单的两态容器管理（Idle/InUse）。

#### Scenario: 空闲队列操作

- **WHEN** 多个任务同时 acquire 同一个池的空闲容器
- **THEN** `RwLock<VecDeque>` 保证 pop_front 的原子性
- **WHEN** 健康检查与 acquire 竞争同一容器
- **THEN** 健康检查仅操作 Idle 容器，acquire 将容器标记为 InUse 后健康检查不再触碰

### Requirement: 可靠性与故障恢复

系统 SHALL 实现孤儿清理和 API 超时机制。

#### Scenario: 孤儿容器清理

- **WHEN** 系统启动
- **THEN** 按标签 `com.noj.judge.pool=true` 过滤并 `docker rm -f` 清理所有残留容器

#### Scenario: bollard API 超时

- **WHEN** docker create/start 调用超过 30s/5s
- **THEN** 调用超时返回错误，记录 ERROR 日志
- **WHEN** docker rm -f 调用超过 10s
- **THEN** 调用超时返回错误，记录 ERROR 日志（不追踪泄漏）

## REMOVED Requirements

### Requirement: 自动扩缩容

**Reason**: NOJ 当前为单 Worker 部署，无需自动扩缩容。Scaler 的滑动窗口指标计算存在 3 个已知 Bug（QPS 分母/窗口不匹配、到达时间戳失真、sample_count 设计缺陷）。修复这些 Bug 的工作量不足以在当前规模下提供价值。

**Migration**: 池大小由 `POOL_MIN_SIZE` 和 `POOL_MAX_SIZE` 固定控制。运维人员如需调整容量，修改配置后重启 noj-judge 即可。

### Requirement: 可观测性

**Reason**: Prometheus /metrics 端点在 NOJ 当前部署中从不被消费（无 Prometheus + Grafana 栈），增加 axum 依赖和 ~120 行代码却无实际价值。

**Migration**: 池关键状态通过 tracing 日志输出（每 30s Supervisor 快照）。运维人员可通过 `grep pool_status` 提取指标。

### Requirement: 动态内存调整

**Reason**: 当前实现仅支持内存下调（不超过 Pool 初始配置）。在单镜像部署场景下，所有任务共享同一内存限制，无需 per-task 动态调整。`docker update` 调用增加了每次 acquire 的延迟开销。

**Migration**: 容器创建时直接使用 `POOL_MEMORY_MB` 作为内存限制。评测脚本通过自身的 `evaluate.py` 内的资源感知逻辑处理不同题目的内存需求。

### Requirement: Per-Image 资源配置

**Reason**: NOJ 当前仅使用 `noj-judge-python` 单个镜像，per-image 覆盖机制从未被使用。

**Migration**: 所有镜像共享全局 `POOL_MEMORY_MB` 和 `POOL_CPU` 配置。未来如需 per-image 配置，可重新引入。
