## ADDED Requirements

### Requirement: 统一容器池管理

系统 SHALL 使用 PoolManager 对所有评测容器进行统一管理。PoolManager 替代现有的 Semaphore 并发控制模型。

#### Scenario: 启动时创建初始池

- **WHEN** noj-judge 启动且 `POOL_ENABLED=true`
- **THEN** 系统对 `POOL_IMAGES` 中每个镜像执行 `docker pull`（失败重试 3 次，间隔 5s）
- **THEN** 每个镜像创建 `POOL_INITIAL_SIZE` 个容器，CMD 设为 `sleep infinity`，使用 `POOL_MEMORY_MB` 和 `POOL_CPU` 作为资源限制
- **THEN** 容器全部就绪后，主循环开始从 MQ 拉取任务

#### Scenario: 启动时预拉取镜像失败

- **WHEN** 对某个镜像的 `docker pull` 经过 3 次重试仍失败
- **THEN** 系统记录 `warn!` 日志跳过该镜像
- **THEN** 该镜像的池维持为空，系统正常启动，任务通过即时创建路径执行

#### Scenario: 池禁用

- **WHEN** `POOL_ENABLED=false`
- **THEN** 系统不创建池管理器
- **THEN** 评测流程回退到现有模式（Semaphore 控制并发，`create_container` → `start_container` → `run` → `remove`）
- **THEN** 提示：此模式下 `MAX_CONCURRENT` 替代 `POOL_MAX_SIZE` 控制并发

### Requirement: 容器分配与等待

系统 SHALL 从池中分配空闲容器执行评测。无空闲容器时，若未达容量上限则即时创建，若已达上限则排队等待。

#### Scenario: 有空闲容器

- **WHEN** 评测任务到达
- **THEN** 系统根据 `task.judge_image` 查找对应镜像的空闲容器队列
- **THEN** 若队列非空，取出一个容器，`in_flight` 计数器 +1
- **THEN** 系统执行文件注入和评测命令

#### Scenario: 无空闲容器但未达上限

- **WHEN** 空闲队列为空且 `in_flight < POOL_MAX_SIZE`
- **THEN** 系统立即创建一个新容器（CMD = `sleep infinity`，资源限制同预热容器）
- **THEN** 该容器直接分配给当前任务（不等预热）
- **THEN** `in_flight` 计数器 +1

#### Scenario: 无空闲容器且已达上限

- **WHEN** 空闲队列为空且 `in_flight >= POOL_MAX_SIZE`
- **THEN** 当前任务阻塞等待，直到有容器被释放
- **THEN** 系统记录排队时间用于扩缩容指标

#### Scenario: 镜像名匹配

- **WHEN** 系统按 `task.judge_image` 查找池
- **THEN** 若池中存在 `image` 且 `task.judge_image` 与池注册镜像名在去除默认 tag（`:latest` 视为等价于无 tag）后一致，视为匹配
- **THEN** 若无匹配池，系统报错日志并触发即时创建路径

### Requirement: 动态内存调整

系统 SHALL 在 exec 执行前通过 `docker update` 将容器内存限制调整为 `task.memory_limit_mb`，保证 OOM 检测正确。

#### Scenario: exec 前调整内存

- **WHEN** 容器已分配给任务
- **THEN** 系统调用 `docker.update_container(memory = task.memory_limit_mb)`
- **THEN** 若 `task.memory_limit_mb > POOL_MEMORY_MB`，报错并拒绝执行（不支持大于池硬上限的任务）

#### Scenario: 运行时 OOM 检测

- **WHEN** 容器内进程分配内存超过 `task.memory_limit_mb`
- **THEN** Docker OOM killer 终止进程，退出码 137
- **THEN** 系统正确报告 `MemoryLimitExceeded`

### Requirement: 文件注入 (docker cp)

系统 SHALL 将支持包和用户代码通过 tar 打包 + `docker put_archive` 注入到容器内的 `/tmp/` 目录。

#### Scenario: tar 打包并复制

- **WHEN** 支持包已解压、用户代码已写入临时目录
- **THEN** 系统将临时目录全部内容 tar 打包为内存字节流
- **THEN** 系统调用 `docker.put_archive("/tmp", tar_bytes)` 复制到容器内

#### Scenario: tar 安全过滤

- **WHEN** tar 打包时扫描到符号链接文件
- **THEN** 系统跳过该文件（不打包符号链接）
- **WHEN** 文件名包含 `..` 路径组件
- **THEN** 系统跳过该条目

#### Scenario: tar 大小超限

- **WHEN** 临时目录总大小超过 `POOL_MAX_ARCHIVE_MB`
- **THEN** 系统报错并跳过该任务（避免内存 OOM）

### Requirement: 评测执行 (docker exec)

系统 SHALL 在文件注入后通过 Docker exec API 执行评测命令，并流式捕获 stdout/stderr。

#### Scenario: 正常执行

- **WHEN** 系统执行 `docker.create_exec` + `start_exec`
- **THEN** 流式捕获 stdout/stderr
- **THEN** `tokio::select!` 竞速 exec stream 与超时定时器

#### Scenario: exec 超时

- **WHEN** 评测运行超过 `time_limit_ms + 5000ms`
- **THEN** 系统先发送 `docker stop -t 2`（SIGTERM + 2s 等待进程 flush）
- **THEN** 若仍未退出，`docker kill`（SIGKILL）
- **THEN** 剩余日志被捕获，状态设为 TimeLimitExceeded

### Requirement: 容器释放与回补

系统 SHALL 在任务完成后删除容器，并在池空闲数低于目标时触发异步回补。

#### Scenario: 任务完成释放

- **WHEN** 评测任务完成（成功或失败）
- **THEN** `in_flight` 计数器 -1
- **THEN** 系统执行 `docker rm -f` 删除容器
- **THEN** 若当前空闲容器数 < target_depth 的 50%，触发异步回补

#### Scenario: 异步回补

- **WHEN** 回补逻辑触发
- **THEN** 后台 `tokio::spawn` 创建并启动一个新容器
- **THEN** 新容器放入对应镜像的空闲队列

### Requirement: 健康检查

系统 SHALL 定期检查池内容器的健康状态，自动移除异常容器并回补。

#### Scenario: 容器异常死亡

- **WHEN** 健康检查（每 5s）发现池中某个容器非 running
- **THEN** 从池中移除该容器，触发回补

#### Scenario: 空闲超时清理

- **WHEN** 容器在空闲队列中停留时间超过 `POOL_IDLE_TIMEOUT` 秒
- **THEN** 系统移除并删除该容器，不触发回补

### Requirement: 自动扩缩容

系统 SHALL 根据本地 QPS、排队时间和利用率指标自动调整目标池深度。

#### Scenario: 扩—排队时间过长

- **WHEN** acquire 的排队平均等待时间在滑动窗口内 > 500ms
- **THEN** target_depth +1
- **WHEN** 排队时间 > 1000ms
- **THEN** target_depth +2

#### Scenario: 扩—即时创建率过高

- **WHEN** 即时创建的容器比例（miss_rate）超过 30%
- **THEN** target_depth +1

#### Scenario: 缩—利用率持续偏低

- **WHEN** 空闲容器比例连续 2 个周期 > 40%
- **THEN** target_depth -1
- **WHEN** 空闲比例连续 3 个周期 > 60%
- **THEN** target_depth -1（叠加）

#### Scenario: 深度边界

- **WHEN** target_depth 超出 `POOL_MAX_SIZE`
- **THEN** 截断为 `POOL_MAX_SIZE`
- **WHEN** target_depth 低于 `POOL_MIN_SIZE`
- **THEN** 提升为 `POOL_MIN_SIZE`

### Requirement: 优雅关闭

系统 SHALL 在 SIGTERM 时按顺序关闭：停止拉取 → inflight 完成 → 取消回补 → 清理池。

#### Scenario: 收到 SIGTERM

- **WHEN** noj-judge 收到 SIGTERM
- **THEN** 主循环停止拉取新任务
- **THEN** 当前阻塞在 acquire 的任务返回错误
- **THEN** 设置 CancellationToken 通知后台回补跳过
- **THEN** 等待所有 inflight 任务完成
- **THEN** 对所有池中容器执行 `docker rm -f`

### Requirement: 容器安全加固

系统 SHALL 在创建所有容器时应用最小权限配置。

#### Scenario: 容器安全配置

- **WHEN** 任何池容器被创建
- **THEN** HostConfig 包含 CapDrop=["ALL"], SecurityOpt=["no-new-privileges:true"], Privileged=false, ReadonlyRootfs=true, NetworkMode=none
- **THEN** MemorySwap 与 Memory 同值（禁用 swap），MemorySwappiness=0

#### Scenario: swap 数据完整性

- **WHEN** docker update 下调内存限制
- **THEN** MemorySwap 同步调整为 `task.memory_limit_mb × 1024²`
- **THEN** 进程因内存超限被 OOM killer 终止，退出码 137

### Requirement: 并发安全与状态管理

系统 SHALL 使用容器状态机（Idle/InUse/Removing/Dead）管理生命周期。

#### Scenario: 健康检查竞争安全

- **WHEN** 健康检查发现空闲容器异常
- **THEN** 仅标记状态为 Dead，不移除容器
- **THEN** acquire 或 release 在操作 Dead 容器时完成实际移除

#### Scenario: 回补请求合并

- **WHEN** 200ms 窗口内收到多个回补触发信号
- **THEN** 仅执行一次回补创建

### Requirement: 可靠性与故障恢复

系统 SHALL 实现孤儿清理、API 超时和重试机制。

#### Scenario: bollard API 超时

- **WHEN** docker update/inspect 调用超过 5s
- **THEN** 调用超时返回错误，记录 ERROR 日志
- **WHEN** docker rm -f 调用超过 10s
- **THEN** 调用超时返回错误，容器加入泄漏追踪列表

#### Scenario: 孤儿容器清理

- **WHEN** 系统启动且 POOL_ENABLED=true
- **THEN** 按标签 `com.noj.judge.pool=true` 过滤并清理所有残留容器

#### Scenario: docker rm -f 重试

- **WHEN** release 路径中 rm -f 首次失败
- **THEN** 退避重试 3 次（间隔 100ms, 500ms, 2s）
- **WHEN** 全部 3 次重试失败
- **THEN** 容器记录到泄漏追踪列表，健康检查线程定期重试清理

### Requirement: 可观测性

系统 SHALL 暴露 Prometheus 指标用于运维监控。

#### Scenario: 指标暴露

- **WHEN** 池系统运行中
- **THEN** Prometheus 端点 `/metrics` 返回以下指标：
  - pool_idle_containers{image}
  - pool_in_flight
  - pool_queue_wait_seconds
  - pool_miss_total
  - pool_target_depth{image}
  - pool_scale_actions{action}
  - pool_leaked_containers
  - pool_bollard_errors

### Requirement: 支持包完整性校验

系统 SHALL 在 zip 解压阶段实施多层防护。

#### Scenario: zip 解压防护

- **WHEN** 解压支持包 zip
- **THEN** 解压后总大小不超过 POOL_MAX_ARCHIVE_MB
- **THEN** 拒绝 overlapping entries（相同路径重复）
- **THEN** 拒绝包含 `..` 组件的 entry
- **THEN** 单文件大小不超过 POOL_MAX_ARCHIVE_MB

### Requirement: Per-Image 资源配置

系统 SHALL 支持按镜像名称覆盖全局内存限制。

#### Scenario: per-image 内存配置

- **WHEN** 环境变量 `POOL_MEMORY_MB_NOJ_JUDGE_PYTHON` 存在
- **THEN** 对应 noj-judge-python 镜像的池使用该值而非全局 POOL_MEMORY_MB
- **WHEN** 无对应 per-image 变量
- **THEN** 使用全局 POOL_MEMORY_MB
- **THEN** 进程退出
