## Context

noj-judge 当前对每个评测任务执行完整的 Docker 容器生命周期：`create_container` → `start_container` → 轮询等待退出 → `capture_logs` → `remove_container`。其中 `create` 和 `start` 两步合计产生 300-800ms 的固定延迟。并发控制通过 tokio `Semaphore(MAX_CONCURRENT)` 实现（默认 2），镜像依赖 `ensure_image_local()` 仅检查本地存在，不自动拉取。

Issue #32 要求引入容器池化和性能优化。经过讨论，确定了以下设计方向：

- **统一容器池**：PoolManager 替代 Semaphore，`POOL_SIZE` = 最大并发数 = 池容量上限。无 fallback 路径——所有容器都通过池创建和管理
- **用完即删**：任务完毕后 `docker rm -f` 删除容器，不复用
- **自动扩缩容**：每个 noj-judge 实例根据本地 QPS、排队时间、利用率等指标自动调整目标池深度
- **动态内存调整**：通过 `docker update` 在 exec 前将容器内存限制调整为 `task.memory_limit_mb`
- **文件注入**：通过 tar 打包 + `docker put_archive` 将支持包和用户代码注入容器

## Goals / Non-Goals

**Goals:**

- 消除任务级 Docker 容器 create/start 延迟（~500ms/任务）
- 镜像预拉取消除首次任务拉取延迟
- 池化统一管理并发性，替代现有 Semaphore 模型
- 根据负载自动调整池深度，避免固定配置的过度或不足
- 容器用完即删，不引入安全隔离风险
- 100% 向后兼容（行为等价，API/协议不变）

**Non-Goals:**

- 容器复用（任务间共享容器）— 安全隔离需求高于性能收益，留待后续
- 跨实例协调扩缩容 — 每个 noj-judge 实例独立决策，Redis MQ 的 BRPOP 天然做负载分发
- 修改评测结果协议、Redis MQ 数据结构、`---RESULT---` 标记协议

## Decisions

### D1: docker exec 代替 create→start→run

**选择**：容器启动时 CMD 设为 `sleep infinity` 保持运行，任务到达后用 bollard `exec` API 执行评测命令。

| 对比项 | create→start→run（现方案） | docker exec（池化方案） |
|--------|---------------------------|------------------------|
| 延迟 | 300-800ms（固定开销） | ~50ms（仅 exec 建立开销） |
| 超时处理 | 容器退出或 kill 容器 | tokio::select! 竞速 exec stream 与 sleep |
| 输出捕获 | capture_container_logs | start_exec 流式 stdout/stderr |

**理由**：`docker exec` 和 `docker run` 底层本质一致（containerd shim + runc），区别仅在于前者的 container namespace 已存在，省去 cgroup/mount/network 创建开销。安全隔离无差异。

### D2: docker update 动态调整内存限制

**选择**：池容器在启动时使用 `POOL_MEMORY_MB` 创建（默认 256MB），exec 执行前通过 `docker update` 将容器内存限制临时下调到 `task.memory_limit_mb`，保证 OOM 检测正确。

**流程**：
```text
容器创建:  memory = POOL_MEMORY_MB（固定最大值）
    ↓
任务到达 → docker update memory = task.memory_limit_mb
    ↓ docker cp + exec
任务完成 → docker rm -f
    ↓
回补容器: memory = POOL_MEMORY_MB（恢复默认）
```

**理由**：
- 解决了固定配额池的最大问题：预热容器内存限制和任务不匹配导致 OOM 检测失败
- `docker update` 支持运行时下调内存限，bollard 提供 `update_container` API，实现可靠
- `POOL_MEMORY_MB` 作为硬上限，`task.memory_limit_mb` 不得超过它。若超过，则报错提示镜像需要更大的 POOL_MEMORY_MB 配置

### D3: 文件注入—docker cp (put_archive)

**选择**：池容器不绑定挂载，任务到达后将工作目录内容 tar 打包为内存字节流，通过 bollard `put_archive` API 上传到容器内 `/tmp/`。

**流程**：
```text
创建临时目录 → 解码支持包 → 解压 → 写用户代码
    → tar 打包目录 → docker put_archive("/tmp", tar_bytes)
    → docker exec(judge_command)
```

**理由**：
- 池容器无法动态添加绑定挂载（挂载在 `docker create` 时设定）
- `put_archive` 延迟约 10-30ms（< 10MB 时），远低于 create/start 的 500ms

**安全约束**：
- tar 打包前过滤符号链接文件（`is_symlink`）+ 拒绝 `..` 路径组件
- 工作目录总大小超出 `POOL_MAX_ARCHIVE_MB`（默认 25MB）时报错

### D4: 统一池模型（PoolManager 替代 Semaphore）

**选择**：PoolManager 统一管理所有评测容器，不再使用独立的 Semaphore 控制并发。

```text
PoolManager
  ├── per-image Pool: VecDeque<ContainerId>（空闲队列）
  ├── in_flight: AtomicUsize（当前运行中任务数）
  ├── target_depth: AtomicUsize（自动调整的目标深度）
  └── max_depth: usize（POOL_MAX_SIZE，硬上限）

     acquire(image):
       if in_flight < max_depth:
         if 空闲队列有容器 → pop + in_flight++
         else → 即时创建新容器 + in_flight++
       else:
         阻塞等待 release() 信号

     release(container_id):
       docker rm -f container_id
       in_flight--
       通知 acquire 的等待者
       触发异步回补（若空闲数 < target_depth 的 50%）
```

**理由**：
- 消除 Semaphore + Pool 双通道的同步复杂性（之前审阅发现的问题 5）
- 所有容器一视同仁：预创建的和即时创建的都通过池管理，没有两条路径的分裂
- 排队等待逻辑自然融入 acquire，无需额外 `mpsc` 通道
- `in_flight` + `空闲队列` 的简单计数即可实现有界并发

### D5: 自动扩缩容（本地决策）

**选择**：每个 noj-judge 实例独立运行扩缩容循环（`POOL_SCALE_INTERVAL`，默认 60s），根据本地观测指标调整 `target_depth`。同时引入**快速扩容触发器**，在突发流量时无须等待周期即可反应。

**采集指标（滑动窗口 60s）**：
```
arrival_rate     = 任务到达数 / 窗口时长（QPS）
avg_queue_wait   = acquire 成功前的排队总耗时 / 任务数
in_flight_avg    = 平均运行中任务数
idle_ratio       = 平均空闲容器数 / target_depth
miss_count       = 即时创建容器的次数（池空信号）
```

**快速扩容触发器**（在 acquire 路径内同步执行）：
```
// 当有任务开始排队时，立即扩容（仅当未达上限）
on_acquire_queue:
  if target_depth < POOL_MAX_SIZE:
    if 这是该周期内首个排队任务 → target_depth += 1
    if avg_queue_wait(当前周期) > 200ms → target_depth += 1
```

**周期调控算法**：
```
每 POOL_SCALE_INTERVAL:

  scale_up = 0
  scale_down = 0

  // 扩：排队太久或池空太频繁
  if avg_queue_wait > 1000ms → scale_up += 2
  if avg_queue_wait > 500ms  → scale_up += 1
  if miss_rate > 30%         → scale_up += 1

  // 缩：长期利用率低
  if idle_ratio > 40% for ≥2 consecutive intervals → scale_down += 1
  if idle_ratio > 60% for ≥3 consecutive intervals → scale_down += 1

  new_target = clamp(
    target_depth + scale_up - scale_down,
    POOL_MIN_SIZE,      // 硬下限，默认 1
    POOL_MAX_SIZE       // 硬上限，默认 16
  )
```

**理由**：
- 本地决策无需跨实例通信（noj-core 保持无状态，多实例无影响）
- Redis MQ 的 BRPOP 天然做负载分发，本地 QPS 已能反映全局负载趋势
- 排队时间（`avg_queue_wait`）直接反映"池不够用"的用户体验信号
- 固定 POOL_SIZE + 空闲超时的静态方案无法适应负载波动

### D6: 镜像预拉取

**选择**：启动时对 `POOL_IMAGES` 配置的每个镜像执行 `docker pull`（阻塞完成后再开始主循环），不依赖每次任务时的本地检查。

**重试与容错**：
- 拉取失败重试 3 次（间隔 5s）
- 全部失败则记录 `warn!` 日志跳过该镜像的预热，不影响系统启动
- 启动后任务使用该镜像时，走现有错误路径报错（镜像不存在）

### D7: 空闲容器回收

**选择**：池中的空闲容器超过 `POOL_IDLE_TIMEOUT` 秒（默认 300s）未被分配，则从池中移除并删除。**不触发回补**——让池深度自然降低，反映低负载状态。若后续任务到达导致排队，扩缩容机制会自动增加 target_depth。

### D8: 优雅关闭

**选择**：SIGTERM 时执行以下有序关闭流程：
1. 停止主循环（不再 BRPOP）
2. 设置关闭标志，当前阻塞在 `acquire` 的任务立即返回错误
3. 等待所有 inflight 任务完成（轮询 `in_flight == 0`）
4. 取消所有后台正在进行的回补任务（`CancellationToken`）
5. 清理池中所有剩余容器（`docker rm -f`）
6. 进程退出

### D9: 环境变量配置

**选择**：所有新参数通过 `std::env::var()` + `unwrap_or_else()` 模式加载，与现有 config.rs 风格一致。

```rust
pub struct PoolConfig {
    pub enabled: bool,              // POOL_ENABLED (默认: true)
    pub initial_size: usize,        // POOL_INITIAL_SIZE (默认: 2)
    pub max_size: usize,            // POOL_MAX_SIZE (默认: 16)
    pub min_size: usize,            // POOL_MIN_SIZE (默认: 1)
    pub memory_mb: u64,            // POOL_MEMORY_MB (默认: 256)
    pub cpu: f64,                  // POOL_CPU (默认: 0, 0=无限制)
    pub images: Vec<String>,        // POOL_IMAGES (默认: "noj-judge-python")
    pub idle_timeout_secs: u64,    // POOL_IDLE_TIMEOUT (默认: 300)
    pub scale_interval_secs: u64,  // POOL_SCALE_INTERVAL (默认: 60)
    pub max_archive_mb: u64,       // POOL_MAX_ARCHIVE_MB (默认: 25)
    pub kill_grace_secs: u64,      // POOL_KILL_GRACE_SECONDS (默认: 2)
    pub label_prefix: String,      // POOL_LABEL_PREFIX (默认: "com.noj.judge")
}
```

### D10: 容器安全加固

**选择**：所有池容器在创建时应用最小权限配置，确保安全隔离不因容器池化而削弱。

```rust
HostConfig {
    CapDrop: Some(vec!["ALL"]),          // 删除全部 capability
    SecurityOpt: Some(vec!["no-new-privileges:true"]),
    Privileged: Some(false),
    ReadonlyRootfs: Some(true),          // 只读根文件系统
    NetworkMode: Some("none"),           // 禁用网络
    MemorySwap: Some(task.memory_limit_mb * 1024 * 1024),
    MemorySwappiness: Some(0),
}
```

**理由**：
- `CapDrop=ALL` 消除 CAP_NET_RAW、CAP_SYS_PTRACE 等可能用于容器逃逸的能力
- `no-new-privileges` 防止通过 `setuid` 二进制提权
- `ReadonlyRootfs=true` 阻止恶意代码写 `/tmp/` 以外路径
- swap 必须显式禁用（`MemorySwap = task.memory_limit_mb`），否则进程可通过 swap 绕过 OOM 限制

### D11: 并发安全与状态一致性

**选择**：引入容器状态机管理每个容器的生命周期，以 Mutex+RwLock 保护并发访问。

```rust
enum ContainerState { Idle, InUse, Removing, Dead }
```

**并发操作规则**：
- **acquire**: Idle → InUse（原子性转换）
- **release**: InUse → Removing → docker rm -f → 移除 → notify
- **health_check**: Idle → inspect → 异常则标记 Dead（不移除，避免与 acquire 竞争）
- **replenish**: 创建容器 → 就绪 → Idle 入队

**后台任务管理**：
- 所有 `tokio::spawn` 注册结构化错误处理，禁止 `unwrap()`
- Supervisor 任务（周期 30s）检查后台任务存活，崩溃后自动重启
- 回补请求添加 200ms debounce，确保同一时刻只有一个回补任务在运行

### D12: 可靠性与可观测性

**选择**：实现熔断降级、孤儿清理、API 超时和 Prometheus 指标暴露。

**bollard API 超时**：轻量操作（update/inspect）5s，exec 沿用任务超时，rm -f 10s

**熔断降级**：
- 30s 滑动窗口内 bollard 错误率 > 50% → 自动切换为旧 Semaphore 模式（AtomicBool 切换，不重启进程）
- 每 30s 探测 Docker 恢复 → 自动切回池模式

**孤儿容器清理**：
- 启动时按标签 `com.noj.judge.pool=true` 过滤并清理残留容器
- 所有池容器创建时均打上该标签

**docker rm -f 重试**：
- 退避重试 3 次（间隔 100ms, 500ms, 2s）
- 全部失败时记录 ERROR 日志并加入泄漏追踪列表，由健康检查定期重试

**Prometheus 指标**：
```
pool_idle_containers{image=}    # 空闲容器数
pool_in_flight                  # 运行中任务数
pool_queue_wait_seconds         # 排队时间（histogram）
pool_miss_total                 # 即时创建次数
pool_target_depth{image=}       # 目标深度
pool_scale_actions{up/down}     # 扩缩容计数
pool_leaked_containers          # 泄漏容器数
pool_bollard_errors             # Docker API 错误数
```

### D13: 支持包完整性校验

**选择**：在 zip 解压阶段实施多层防护，与 tar 打包阶段的安全过滤形成纵深防御。

**zip 解压防护**：
- 解压后总大小限制 = `POOL_MAX_ARCHIVE_MB`（默认 25MB）
- 拒绝 overlapping entries（同名路径出现两次直接报错）
- 拒绝含 `..` 路径组件的 entry
- 单文件大小限制 = `POOL_MAX_ARCHIVE_MB`
- 可选：SHA256 checksum 校验

### D14: Per-Image 资源配置

**选择**：支持通过 `POOL_MEMORY_MB_{IMAGE_NAME}` 环境变量覆盖全局默认值，为不同语言/评测镜像设置不同的内存硬上限。

```bash
POOL_MEMORY_MB=256                      # 全局默认
POOL_MEMORY_MB_NOJ_JUDGE_PYTHON=1024   # Python 镜像专用
```

配置加载时，如果存在 `POOL_MEMORY_MB_<NORMALIZED_IMAGE_NAME>` 则使用该值，否则使用全局 `POOL_MEMORY_MB`。

## Risks / Trade-offs

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| **容器被宿主机 OOM 误杀** | sleep infinity 容器几乎不占内存但 cgroup 仍存在 | 健康检查间隔 5s，发现 Dead 容器立即移除并回补 |
| **exec 超时 kill 后日志不完整** | SIGKILL 时 stdout/stderr buffer 未 flush | 先 `docker stop -t ${POOL_KILL_GRACE_SECONDS}` 等待，再 `kill` |
| **预拉取镜像失败阻塞启动** | 网络问题导致启动延迟 | 重试 3 次后跳过，系统仍可用 |
| **tar 包过大导致进程 OOM** | 大支持包并发 tar 消耗内存 | `POOL_MAX_ARCHIVE_MB` 限制（默认 25MB）；并发打包数受 Semaphore 限制 |
| **put_archive 符号链穿越** | 支持包含恶意符号链接 | tar 层过滤 + zip 层拒绝 `..`，双层防护 |
| **镜像名不匹配** | judge_image 带 tag 与池不匹配 | acquire 时归一化匹配（strip default tag） |
| **扩缩容振荡** | QPS 波动导致 target_depth 跳变 | 缩容需连续 2-3 周期达阈值；快速扩容仅单向不引起振荡 |
| **池骤降影响吞吐量** | 空闲超时清空池后突发流量 | 即时创建确保任务不阻塞，回补逐步重建 |
| **Docker daemon 不可用** | 所有 API 调用 hang 住 | bollard 调用设超时；错误率 >50% 熔断切旧模式；恢复后自动切回 |
| **进程 SIGKILL 残留孤儿容器** | 池容器成僵尸长期累积 | 启动时按标签清理残留 |
| **回补创建过量容器** | 多个 release 同时触发回补 | 200ms debounce 合并回补请求 |
| **异步 task panic 状态不一致** | 后台 task 静默终止，in_flight 失准 | Supervisor 检测并重启；JoinHandle 结构化错误处理 |
| **滑动窗口冷启动** | 重启后扩缩容决策质量差 | 前 2 个周期仅扩不缩，起步 target = POOL_INITIAL_SIZE + 1 |
