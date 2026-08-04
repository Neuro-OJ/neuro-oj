## MODIFIED Requirements

### Requirement: 容器创建与配置

系统 SHALL 使用 bollard 创建 Docker 容器。容器不再有池预创建：每次评测任务即时创建
两个容器（Evaluator + Solution），创建参数直接按任务规格设置。

| 配置项                      | 值                                                          | 说明                                             |
| --------------------------- | ----------------------------------------------------------- | ------------------------------------------------- |
| Image                       | `runtime_config.evaluator.image` / `runtime_config.solution.image` | 题目指定的镜像                       |
| Cmd                         | `sleep infinity`                                             | 保持运行，通过 exec 执行评测                     |
| WorkingDir                  | `/workspace`                                                 | 评测工作目录                                     |
| HostConfig.Binds            | 无                                                          | 文件通过 docker exec + tar 注入                  |
| HostConfig.Memory           | `memory_limit_mb × 1024²`                                   | 创建时直接按任务规格设置，无需事后下调           |
| HostConfig.MemorySwap       | 与 Memory 同值                                              | 禁用 swap                                        |
| HostConfig.MemorySwappiness | 0                                                           | 禁用 swap                                        |
| HostConfig.NetworkMode      | Evaluator：`none` 或 `bridge`（按 `evaluator.network.enabled`）；Solution：恒 `none` | 见安全隔离 |
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

#### Scenario: evaluator 联网配置

- **WHEN** `runtime_config.evaluator.network.enabled = true`
- **THEN** Evaluator 容器以 `HostConfig.NetworkMode = bridge` 创建
- **THEN** Solution 容器仍以 `HostConfig.NetworkMode = none` 创建
- **WHEN** `runtime_config.evaluator.network` 缺省或 `enabled = false`
- **THEN** Evaluator 与 Solution 均以 `HostConfig.NetworkMode = none` 创建（与现状一致）

#### Scenario: 容器执行路径（双容器路径）

- **WHEN** 双容器创建完成
- **THEN** 系统通过 docker exec `tar xf - -C /workspace` 注入支持包文件
- **THEN** 系统通过 docker exec 在 Evaluator 容器运行 `runtime_config.evaluator.command`
- **THEN** 系统通过 docker exec 在 Solution 容器运行 solution host

#### Scenario: Docker 镜像不存在

- **WHEN** 创建容器时镜像未就绪，docker pull 失败（无重试）
- **THEN** 返回 SystemError
- **THEN** 错误信息包含镜像名和构建提示

### Requirement: 安全隔离

系统 SHALL 确保用户代码在隔离环境中执行：

- Solution 容器网络禁用（NetworkMode: none）；Evaluator 容器网络按题目配置（缺省禁用）
- 容器内存不超出 task.memory_limit_mb
- 容器 CPU 限制为 1 核
- 不挂载宿主机 /etc、/proc、/sys、/var/run/docker.sock 等敏感路径
- 仅挂载临时工作目录

#### Scenario: Solution 网络隔离

- **WHEN** solution 用户代码尝试发起网络请求
- **THEN** 网络请求失败（solution 容器无网络接口）

#### Scenario: Evaluator 网络按配置隔离

- **WHEN** 题目未开启 evaluator 联网（`network.enabled` 缺省或 false）
- **THEN** evaluator 容器内网络请求失败（无网络接口）
- **WHEN** 题目开启 evaluator 联网（`network.enabled = true`）
- **THEN** evaluator 容器可发起网络请求（bridge 模式），solution 仍无网

#### Scenario: CPU 限制

- **WHEN** 容器内执行 CPU 密集型计算
- **THEN** 容器使用的 CPU 不超过配置的 NanoCpus 值

#### Scenario: 敏感路径防护

- **WHEN** 容器内检查 /etc、/proc、/var/run/docker.sock 等敏感路径
- **THEN** 这些路径在容器内不可访问（仅挂载的临时工作目录可用）

#### Scenario: 内存限制生效

- **WHEN** 用户代码分配内存超过 memory_limit_mb
- **THEN** Docker OOM killer 终止进程，容器退出码 137
