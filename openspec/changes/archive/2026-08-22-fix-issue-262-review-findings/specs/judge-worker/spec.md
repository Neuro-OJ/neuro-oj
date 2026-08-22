## ADDED Requirements

### Requirement: 评测并发上限

每个 noj-judge 实例 SHALL 限制同时执行的评测任务数量。该上限 SHALL 通过 `JUDGE_MAX_CONCURRENT_JUDGES` 环境变量配置；变量缺失、为零或不是正整数时 MUST 使用安全的有限默认值。任务拉取不得无限制地将 Redis backlog 转换为已启动的 Docker 评测任务。

#### Scenario: 达到并发上限后暂停拉取

- **WHEN** 当前已有的评测任务数量达到该实例的并发上限
- **THEN** judge 不再拉取新的评测任务，直到已有任务完成或被终止

#### Scenario: 任务完成后释放并发额度

- **WHEN** 一个评测任务完成、失败或被优雅关闭流程回收
- **THEN** 该任务释放并发额度，后续任务可以继续被拉取

#### Scenario: 默认配置保持有限并发

- **WHEN** 未配置 `JUDGE_MAX_CONCURRENT_JUDGES` 或配置无效值
- **THEN** judge 使用大于零且有限的默认并发上限，并正常启动

#### Scenario: 优雅关闭等待受限任务

- **WHEN** judge 收到关闭信号且仍有评测任务运行
- **THEN** judge 仅等待当前受并发上限约束的 in-flight 任务，并按既有 drain 超时策略退出

### Requirement: 评测容器 CPU 上限

每个 noj-judge 创建的 Evaluator 与 Solution 容器 SHALL 设置 Docker CPU 限制。
该限制 SHALL 通过 `JUDGE_CPU_LIMIT_MILLICORES` 配置，单位为 millicores，默认
`1000`（1 个 CPU 核）；仅 `100` 至 `16000` 范围内的值有效，缺失、零值或越界值
MUST 回退到默认值。CPU 限制不得因配置错误被解释为 Docker 的“不限制”。

#### Scenario: 使用配置的 CPU 上限

- **WHEN** Worker 配置 `JUDGE_CPU_LIMIT_MILLICORES=2500`
- **THEN** Evaluator 与 Solution 容器的 Docker `nano_cpus` 均设置为 `2500000000`

#### Scenario: CPU 配置无效时安全回退

- **WHEN** CPU 配置缺失、为零或超出有效范围
- **THEN** Worker 使用 `1000m` 的有限 CPU 上限并正常启动

### Requirement: 支持包缓存淘汰并发安全

同一 noj-judge 进程内对同一支持包缓存目录的读取、写入和容量淘汰 SHALL 串行化，
避免多个评测任务依据不同目录快照交叉删除缓存文件。缓存写入 MUST 继续使用临时
文件加 rename 的原子替换方式。

#### Scenario: 并发写入共享缓存

- **WHEN** 多个评测任务同时向同一缓存目录写入支持包并触发容量检查
- **THEN** 每次扫描与淘汰在共享目录锁内完成，最终缓存不超过配置的文件数与大小上限
