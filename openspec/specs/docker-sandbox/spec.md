## Purpose

定义 Neuro OJ 评测沙箱的基础设施规范。no-judge 使用 Docker
容器为每道题目创建隔离的评测环境，限制资源访问并防止恶意代码逃逸。

## Requirements

### Requirement: 容器创建与配置

系统 SHALL 使用 bollard 创建 Docker 容器。容器分两种创建场景：池预创建（启动时）和即时创建（池空未达上限时）。两者的配置差异仅在于创建时机不同，安全限制相同。

| 配置项 | 值 | 说明 |
|--------|-----|------|
| Image | task.judge_image | 题目指定的 Docker 镜像，启动时预拉取 |
| Cmd | `sleep infinity` | 全部容器均设为此命令保持运行，通过 exec 执行评测 |
| HostConfig.Binds | 无 | 文件通过 put_archive 注入 |
| HostConfig.Memory | `POOL_MEMORY_MB × 1024²`（初始）→ 运行时 `docker update` 下调 | 初始为池硬上限，exec 前调整到任务规格 |
| HostConfig.MemorySwap | task.memory_limit_mb × 1024² | 禁用 swap（与 Memory 同值） |
| HostConfig.MemorySwappiness | 0 | 禁用 swap |
| HostConfig.NanoCpus | `POOL_CPU × 10⁹`（0=无限制） | CPU 限制 |
| HostConfig.NetworkMode | none | 禁用网络 |
| HostConfig.CapDrop | ["ALL"] | Drop 全部 capability |
| HostConfig.SecurityOpt | ["no-new-privileges:true"] | 禁止通过 setuid 提权 |
| HostConfig.Privileged | false | 非特权模式 |
| HostConfig.ReadonlyRootfs | true | 只读根文件系统 |
| HostConfig.AutoRemove | false | 手动管理生命周期 |

#### Scenario: 池预创建容器

- **WHEN** noj-judge 启动且 POOL_ENABLED=true
- **THEN** 预创建 POOL_INITIAL_SIZE 个容器，CMD = `sleep infinity`
- **THEN** 容器启动后进入空闲队列等待任务分配

#### Scenario: 即时创建容器

- **WHEN** 池空闲队列为空且 in_flight < POOL_MAX_SIZE
- **THEN** 立即创建新容器，CMD = `sleep infinity`
- **THEN** 该容器直接分配给当前任务（不等预热）

#### Scenario: 容器执行路径（池化路径）

- **WHEN** 容器分配给评测任务
- **THEN** 系统执行 `docker.update_container(memory = task.memory_limit_mb)` 调整内存
- **THEN** 系统通过 put_archive 注入文件到 `/tmp/`
- **THEN** 系统通过 docker exec 执行 `task.judge_command`

#### Scenario: Docker 镜像不存在

- **WHEN** 启动时预拉取失败导致镜像未就绪，且后续任务使用该镜像
- **THEN** 即时创建路径中 docker pull 再次尝试（无重试），失败时返回 SystemError
- **THEN** 错误信息包含镜像名和构建提示

### Requirement: 容器执行与输出捕获

系统 SHALL 通过 docker exec 在容器中执行评测命令（而非 create → start → run），捕获 stdout/stderr，并在超时时有序终止。

#### Scenario: 正常执行

- **WHEN** 文件已通过 put_archive 注入到容器 `/tmp/`
- **WHEN** 系统通过 docker exec 执行 `task.judge_command`
- **THEN** 系统流式捕获 stdout/stderr
- **THEN** `tokio::select!` 竞速 exec stream 与超时定时器

#### Scenario: 执行超时

- **WHEN** 容器内 exec 运行时间超过 `time_limit_ms + 5s`
- **THEN** 系统先调用 `docker stop -t 2`（SIGTERM + 2s 等待）
- **THEN** 若仍运行则 `docker kill`（SIGKILL）
- **THEN** 捕获剩余日志输出

#### Scenario: 正常退出

- **WHEN** exec 内命令正常执行完毕
- **THEN** 系统返回 stdout、stderr 和退出码

#### Scenario: 非零退出

- **WHEN** exec 内进程以非零退出码退出
- **THEN** 系统保留 stdout/stderr 并标记 RuntimeError 等（由退出码映射）

#### Scenario: 容器清理

- **WHEN** 评测执行完毕（正常或异常）
- **THEN** 容器被 `docker rm -f` 移除
- **THEN** 工作目录被 `fs::remove_dir_all` 删除
- **THEN** 池管理器检查是否需要回补容器

### Requirement: 用户代码注入

系统 SHALL 将 task.code 以 task.file_name
为文件名写入临时目录，若文件已存在则覆盖。

#### Scenario: 写入用户代码

- **WHEN** 支持包已解压到临时目录
- **THEN** 系统将 task.code 写入 `{work_dir}/{task.file_name}`

#### Scenario: 覆盖已有文件

- **WHEN** 支持包中包含同名的模板/示例文件
- **THEN** 用户代码覆盖该文件

### Requirement: 资源测量

系统 SHALL 在评测容器执行完毕后，测量并返回执行时间和内存峰值。

#### Scenario: 时间测量

- **WHEN** `execute_in_container` 执行评测命令
- **THEN** 系统在 exec 启动前和返回后分别记录 `Instant::now()`，计算差值作为 `time_ms`
- **THEN** `time_ms` 精度为毫秒（纳秒计时器读取），反映 wall-clock 时间

#### Scenario: 内存峰值测量

- **WHEN** exec 执行完毕
- **THEN** 系统在容器内执行 `cat /sys/fs/cgroup/memory/memory.max_usage_in_bytes`（cgroup v1）或 `cat /sys/fs/cgroup/memory.peak`（cgroup v2）
- **THEN** 解析输出字节数，转换为 KB 作为 `memory_kb`
- **WHEN** cgroup 文件不存在或读取失败
- **THEN** `memory_kb` 设为 0，不阻塞评测结果

#### Scenario: 容器未运行或已删除

- **WHEN** 容器已删除导致内存读取失败
- **THEN** `memory_kb` 设为 0，错误记录日志

系统 SHALL 将 task.support_package_base64
解码后解压到临时目录。若该字段为空，跳过此步骤。

#### Scenario: 从 Base64 解码支持包

- **WHEN** support_package_base64 非空
- **THEN** 将 Base64 字符串解码为 zip 字节流，解压到 `{work_dir}/` 下

#### Scenario: 支持包为空

- **WHEN** support_package_base64 为空
- **THEN** 跳过支持包步骤，直接写入用户代码后执行

### Requirement: 安全隔离

系统 SHALL 确保用户代码在隔离环境中执行：

- 容器网络禁用（NetworkMode: none）
- 容器内存不超出 task.memory_limit_mb
- 容器 CPU 限制为 1 核
- 不挂载宿主机 /etc、/proc、/sys、/var/run/docker.sock 等敏感路径
- 仅挂载临时工作目录

#### Scenario: 网络隔离

- **WHEN** 用户代码尝试发起网络请求
- **THEN** 网络请求失败（容器无网络接口）

#### Scenario: CPU 限制

- **WHEN** 容器内执行 CPU 密集型计算
- **THEN** 容器使用的 CPU 不超过配置的 NanoCpus 值

#### Scenario: 敏感路径防护

- **WHEN** 容器内检查 /etc、/proc、/var/run/docker.sock 等敏感路径
- **THEN** 这些路径在容器内不可访问（仅挂载的临时工作目录可用）

#### Scenario: 内存限制生效

- **WHEN** 用户代码分配内存超过 memory_limit_mb
- **THEN** Docker OOM killer 终止进程，容器退出码 137
