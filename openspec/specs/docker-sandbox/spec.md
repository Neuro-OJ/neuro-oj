## Purpose

定义 Neuro OJ 评测沙箱的基础设施规范。no-judge 使用 Docker
容器为每道题目创建隔离的评测环境，限制资源访问并防止恶意代码逃逸。

## Requirements

### Requirement: 容器创建与配置

系统 SHALL 使用 bollard 创建 Docker 容器，配置以下参数：

| 配置项                 | 值                           | 说明                           |
| ---------------------- | ---------------------------- | ------------------------------ |
| Image                  | task.judge_image             | 题目指定的 Docker 镜像         |
| Cmd                    | task.judge_command           | 容器内执行的评测命令           |
| HostConfig.Binds       | work_dir:/tmp                | 挂载临时目录到容器 /tmp        |
| HostConfig.Memory      | task.memory_limit_mb × 1024² | 内存限制                       |
| HostConfig.NanoCpus    | 1 × 10⁹ (1 核)               | CPU 限制                       |
| HostConfig.NetworkMode | none                         | 禁用网络                       |
| HostConfig.AutoRemove  | false                        | 手动管理生命周期以捕获退出日志 |

#### Scenario: 创建并启动容器

- **WHEN** 临时目录已准备好（支持包已解压 + 用户代码已写入）
- **THEN** bollard 创建容器并启动，返回容器 ID

#### Scenario: Docker 镜像不存在

- **WHEN** task.judge_image 对应的镜像在本地不存在
- **THEN** ensure_image_local 返回错误，提示用户先构建镜像；noj-judge
  使用本地构建策略（如 `noj-judge-python` 由 Dockerfile
  提前构建），不从远程自动拉取

### Requirement: 容器执行与输出捕获

系统 SHALL 等待容器退出，捕获完整 stdout 和 stderr，并在超时时强制终止容器。

#### Scenario: 正常退出

- **WHEN** 容器内 judge_command 正常执行完毕（退出码 0）
- **THEN** 系统返回 stdout、stderr 和退出码

#### Scenario: 非零退出

- **WHEN** 容器内进程以非零退出码退出
- **THEN** 系统保留 stdout/stderr 并标记为 RuntimeError

#### Scenario: 执行超时

- **WHEN** 容器运行时间超过 time_limit_ms + 5s
- **THEN** 系统调用 Docker API 强制 kill 容器，标记为 TimeLimitExceeded

#### Scenario: 超时强制终止

- **WHEN** 容器运行时间超过 time_limit_ms + 5s
- **THEN** 系统调用 Docker API kill 容器，capture_container_logs 返回
  exit_code=-1

#### Scenario: 统一清理

- **WHEN** 容器执行完毕（正常或异常）
- **THEN** 容器被 remove_container 移除
- **THEN** 工作目录被 fs::remove_dir_all 删除

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
