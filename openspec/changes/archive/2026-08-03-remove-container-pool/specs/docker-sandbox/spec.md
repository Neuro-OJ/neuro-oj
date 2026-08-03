## MODIFIED Requirements

### Requirement: 容器创建与配置

系统 SHALL 使用 bollard 创建 Docker 容器。容器不再有池预创建：每次评测任务即时创建
两个容器（Evaluator + Solution），两个容器共享同一套安全限制，创建参数直接按任务
规格设置。

| 配置项                      | 值                                                          | 说明                                             |
| --------------------------- | ----------------------------------------------------------- | ------------------------------------------------ |
| Image                       | `runtime_config.evaluator.image` / `runtime_config.solution.image` | 题目指定的镜像                       |
| Cmd                         | `sleep infinity`                                             | 保持运行，通过 exec 执行评测                     |
| WorkingDir                  | `/workspace`                                                 | 评测工作目录                                     |
| HostConfig.Binds            | 无                                                          | 文件通过 docker exec + tar 注入                  |
| HostConfig.Memory           | `memory_limit_mb × 1024²`                                   | 创建时直接按任务规格设置，无需事后下调           |
| HostConfig.MemorySwap       | 与 Memory 同值                                              | 禁用 swap                                        |
| HostConfig.MemorySwappiness | 0                                                           | 禁用 swap                                        |
| HostConfig.NetworkMode      | none                                                        | 禁用网络                                         |
| HostConfig.CapDrop          | ["ALL"]                                                     | Drop 全部 capability                             |
| HostConfig.SecurityOpt      | ["no-new-privileges:true"]                                  | 禁止通过 setuid 提权                             |
| HostConfig.Privileged       | false                                                       | 非特权模式                                       |
| HostConfig.ReadonlyRootfs   | false                                                       | 双容器均非只读（与池时代 true 不同）             |
| HostConfig.AutoRemove       | false                                                       | RAII 手动管理生命周期                            |

#### Scenario: 即时创建双容器

- **WHEN** judge 收到评测任务
- **THEN** 即时创建 Evaluator 容器，CMD = `sleep infinity`，WorkingDir = `/workspace`
- **THEN** 即时创建 Solution 容器，CMD = `sleep infinity`，WorkingDir = `/workspace`
- **THEN** 评测完成后按 RAII 顺序 `docker rm -f` 两个容器
- **THEN** 容器不进入任何复用池，下次评测重新创建

#### Scenario: 容器执行路径（双容器路径）

- **WHEN** 双容器创建完成
- **THEN** 系统通过 docker exec `tar xf - -C /workspace` 注入支持包文件
- **THEN** 系统通过 docker exec 在 Evaluator 容器运行 `runtime_config.evaluator.command`
- **THEN** 系统通过 docker exec 在 Solution 容器运行 solution host

#### Scenario: Docker 镜像不存在

- **WHEN** 创建容器时镜像未就绪，docker pull 失败（无重试）
- **THEN** 返回 SystemError
- **THEN** 错误信息包含镜像名和构建提示

### Requirement: 容器执行与输出捕获

系统 SHALL 通过 docker exec 在容器中执行评测命令（而非 create → start →
run），捕获 stdout/stderr，并在超时时有序终止。

#### Scenario: 正常执行

- **WHEN** 文件已通过 docker exec `tar xf - -C /workspace` 注入到容器 `/workspace`
- **WHEN** 系统通过 docker exec 执行评测命令
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
- **THEN** 容器按 RAII 顺序（Solution → Evaluator）被 `docker rm -f` 移除
- **THEN** 工作目录被 `fs::remove_dir_all` 删除
- **THEN** 无容器回补步骤（容器池已移除）

### Requirement: 资源测量

系统 SHALL 在评测容器执行完毕后，测量并返回执行时间和内存峰值。

#### Scenario: 时间测量

- **WHEN** 评测编排层执行评测命令
- **THEN** 系统在 exec 启动前和返回后分别记录 `Instant::now()`，计算差值作为
  `time_ms`
- **THEN** `time_ms` 精度为毫秒（纳秒计时器读取），反映 wall-clock 时间

#### Scenario: 内存峰值测量

- **WHEN** exec 执行完毕
- **THEN** 系统在容器内执行
  `cat /sys/fs/cgroup/memory/memory.max_usage_in_bytes`（cgroup v1）或
  `cat /sys/fs/cgroup/memory.peak`（cgroup v2）
- **THEN** 解析输出字节数，转换为 KB 作为 `memory_kb`
- **WHEN** cgroup 文件不存在或读取失败
- **THEN** `memory_kb` 设为 0，不阻塞评测结果

#### Scenario: 容器未运行或已删除

- **WHEN** 容器已删除导致内存读取失败
- **THEN** `memory_kb` 设为 0，错误记录日志
