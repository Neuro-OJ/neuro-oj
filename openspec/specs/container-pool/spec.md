## Purpose

定义 Neuro OJ 评测容器池（Container Pool）的基础设施规范。noj-judge 使用
PoolManager 统一管理 Docker
容器的生命周期，包括预创建、分配、释放和健康检查，以提升评测启动速度和资源利用率。

## Requirements

### Requirement: 固定池大小

系统 SHALL 使用固定的最小/最大池大小，不再支持动态调整 target_depth。

#### Scenario: 池大小边界固定

- **WHEN** noj-judge 运行中
- **THEN** 池容器数始终在 `[POOL_MIN_SIZE, POOL_MAX_SIZE]` 范围内
- **THEN** 系统不根据 QPS、排队时间或空闲率调整池大小

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
- **THEN** 若空闲队列长度超过 `POOL_MAX_SIZE`，跳过回补

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

### Requirement: 文件注入 (docker cp)

系统 SHALL 将支持包和用户代码通过 tar 打包 + `docker exec tar xf -`
注入到容器内的 `/tmp/` 目录。

#### Scenario: tar 打包并复制

- **WHEN** 支持包已解压、用户代码已写入临时目录
- **THEN** 系统将临时目录全部内容 tar 打包为内存字节流
- **THEN** 系统通过 `docker exec tar xf - -C /tmp/` 将 tar 数据通过 stdin
  管道注入到容器内

#### Scenario: tar 安全过滤

- **WHEN** tar 打包时扫描到符号链接文件
- **THEN** 系统跳过该文件（不打包符号链接）
- **WHEN** 文件名包含 `..` 路径组件
- **THEN** 系统跳过该条目

#### Scenario: tar 大小超限

- **WHEN** 临时目录总大小超过 `POOL_MAX_ARCHIVE_MB`
- **THEN** 系统报错并跳过该任务（避免内存 OOM）

### Requirement: 评测执行 (docker exec)

系统 SHALL 在文件注入后通过 Docker exec API 执行评测命令，并流式捕获
stdout/stderr。

#### Scenario: 正常执行

- **WHEN** 系统执行 `docker.create_exec` + `start_exec`
- **THEN** 流式捕获 stdout/stderr
- **THEN** `tokio::select!` 竞速 exec stream 与超时定时器

#### Scenario: exec 超时

- **WHEN** 评测运行超过 `time_limit_ms + kill_grace_secs × 1000` ms
- **THEN** 系统先发送 `docker stop -t <kill_grace_secs>`（SIGTERM + 等待进程 flush）
- **THEN** 若仍未退出，`docker kill`（SIGKILL）
- **THEN** 剩余日志被捕获，状态设为 TimeLimitExceeded

### Requirement: 优雅关闭

系统 SHALL 在 SIGTERM 时按顺序关闭：停止拉取 → inflight 完成 → 清理池。

#### Scenario: 收到 SIGTERM

- **WHEN** noj-judge 收到 SIGTERM
- **THEN** 主循环停止拉取新任务
- **THEN** 设置 `shutting_down` 标记阻止新容器创建
- **THEN** 等待所有 inflight 任务完成（最长 30s 超时）
- **THEN** 对所有池中容器执行 `docker rm -f`

### Requirement: 容器安全加固

系统 SHALL 在创建所有容器时应用最小权限配置。

#### Scenario: 容器安全配置

- **WHEN** 任何池容器被创建
- **THEN** HostConfig 包含 CapDrop=["ALL"],
  SecurityOpt=["no-new-privileges:true"], Privileged=false, ReadonlyRootfs=true,
  NetworkMode=none
- **THEN** MemorySwap 与 Memory 同值（禁用 swap），MemorySwappiness=0

#### Scenario: swap 数据完整性

- **WHEN** docker update 下调内存限制
- **THEN** MemorySwap 同步调整为 `task.memory_limit_mb × 1024²`
- **THEN** 进程因内存超限被 OOM killer 终止，退出码 137

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

### Requirement: 支持包完整性校验

系统 SHALL 在 zip 解压阶段实施多层防护。

#### Scenario: zip 解压防护

- **WHEN** 解压支持包 zip
- **THEN** 解压后总大小不超过 POOL_MAX_ARCHIVE_MB
- **THEN** 拒绝 overlapping entries（相同路径重复）
- **THEN** 拒绝包含 `..` 组件的 entry
- **THEN** 单文件大小不超过 POOL_MAX_ARCHIVE_MB
