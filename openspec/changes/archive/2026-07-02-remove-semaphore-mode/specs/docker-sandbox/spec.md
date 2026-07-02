## MODIFIED Requirements

### Requirement: 容器创建与配置

系统 SHALL 使用 bollard 创建 Docker 容器。容器分两种创建场景：池预创建（启动时）和即时创建（池空未达上限时）。两者的配置差异仅在于创建时机不同，安全限制相同。

| 配置项                      | 值                                                            | 说明                                             |
| --------------------------- | ------------------------------------------------------------- | ------------------------------------------------ |
| Image                       | task.judge_image                                              | 题目指定的 Docker 镜像，启动时预拉取             |
| Cmd                         | `sleep infinity`                                              | 全部容器均设为此命令保持运行，通过 exec 执行评测 |
| HostConfig.Binds            | 无                                                            | 文件通过 put_archive 注入                        |
| HostConfig.Memory           | `POOL_MEMORY_MB × 1024²`（初始）→ 运行时 `docker update` 下调 | 初始为池硬上限，exec 前调整到任务规格            |
| HostConfig.MemorySwap       | task.memory_limit_mb × 1024²                                  | 禁用 swap（与 Memory 同值）                      |
| HostConfig.MemorySwappiness | 0                                                             | 禁用 swap                                        |
| HostConfig.NanoCpus         | `POOL_CPU × 10⁹`（0=无限制）                                  | CPU 限制                                         |
| HostConfig.NetworkMode      | none                                                          | 禁用网络                                         |
| HostConfig.CapDrop          | ["ALL"]                                                       | Drop 全部 capability                             |
| HostConfig.SecurityOpt      | ["no-new-privileges:true"]                                    | 禁止通过 setuid 提权                             |
| HostConfig.Privileged       | false                                                         | 非特权模式                                       |
| HostConfig.ReadonlyRootfs   | true                                                          | 只读根文件系统                                   |
| HostConfig.AutoRemove       | false                                                         | 手动管理生命周期                                 |

#### Scenario: 池预创建容器

- **WHEN** noj-judge 启动
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

## REMOVED Requirements

（无移除项）
