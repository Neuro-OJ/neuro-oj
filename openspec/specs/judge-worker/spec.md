## Purpose

定义 noj-judge（Rust 评测 Worker）的核心功能规范。judge-worker 通过 Redis MQ
接收评测任务，在 Docker 容器中执行用户代码， 解析评分脚本的输出，并将结果返回给
noj-core。

## Requirements

### Requirement: 任务拉取

系统 SHALL 通过 BRPOP 命令从 `noj:judge:queue` 列表阻塞拉取评测任务，超时时间 5
秒。

#### Scenario: 成功拉取任务

- **WHEN** `noj:judge:queue` 中有待处理的 JudgeTask JSON
- **THEN** BRPOP 返回任务 JSON，系统反序列化为 JudgeTask 结构体并开始处理

#### Scenario: 队列为空时等待

- **WHEN** `noj:judge:queue` 为空
- **THEN** BRPOP 阻塞等待最多 5 秒后返回空，系统继续下一轮循环

#### Scenario: JSON 反序列化失败

- **WHEN** 拉取到格式非法的 JSON
- **THEN** 系统记录错误日志并跳过该任务，不阻塞后续处理

### Requirement: 结果发布

系统 SHALL 将评测结果序列化为 JSON 后通过 LPUSH 推送到 `noj:judge:results`
列表，供 noj-core 消费。

#### Scenario: 成功发布结果

- **WHEN** 评测完成并组装 JudgeResult
- **THEN** 系统将结果 JSON LPUSH 到 `noj:judge:results`，日志记录 submission_id

#### Scenario: 发布失败

- **WHEN** Redis 连接断开导致 LPUSH 失败
- **THEN** 系统记录错误日志（结果丢失，后续用 Streams 改进）

### Requirement: 评测编排

系统 SHALL 依序执行：从池获取容器/等待容器 → 动态调整内存 → 获取支持包（Base64
解码）→ 解压 → 写入用户代码 → tar 打包 → put_archive 注入 → docker exec 评测 →
解析输出 → 删除容器。

#### Scenario: 评测成功

- **WHEN** 系统从池成功获取容器（或即时创建）
- **WHEN** docker exec 正常退出且 stdout 包含 `---RESULT---` 标记
- **THEN** 系统解析标记后的 JSON，提取 status / score / details 组装 JudgeResult
- **THEN** 容器被 `docker rm -f` 删除
- **THEN** 池管理器检查是否需要回补

#### Scenario: 评测超时

- **WHEN** exec 运行时间超过 `time_limit_ms + 5` 秒
- **THEN** 系统有序终止（`docker stop -t 2` → `docker kill`）
- **THEN** status 设为 `TimeLimitExceeded`，score 设为 0

#### Scenario: 评测脚本无有效输出

- **WHEN** exec 退出但 stdout 中没有 `---RESULT---` 标记，且退出码为 0
- **THEN** status 设为 `SystemError`，output 保留完整 stdout/stderr

#### Scenario: 用户代码运行时错误

- **WHEN** exec 退出但 stdout 中没有 `---RESULT---` 标记，且退出码非 0
- **THEN** status 设为 `RuntimeError`，output 保留完整 stdout/stderr

#### Scenario: 容器内存超限

- **WHEN** 容器因 OOM 被 Docker kill（退出码 137）
- **THEN** status 设为 `MemoryLimitExceeded`，score 设为 0

#### Scenario: 容器创建失败（镜像问题）

- **WHEN** task.judge_image 对应的镜像在本地不存在且无法构建
- **THEN** 评测返回 SystemError，错误信息包含镜像名和构建提示

#### Scenario: 返回资源消耗数据

- **WHEN** 评测完成（正常或异常）
- **THEN** `JudgeResult.time_ms` 包含评测脚本执行时间（毫秒，μs 精度）
- **THEN** `JudgeResult.memory_kb` 包含评测脚本执行期间的内存峰值（KB）
- **WHEN** 资源测量失败（如 cgroup 不可读）
- **THEN** `time_ms` 和 `memory_kb` 返回 0

#### Scenario: 临时目录在错误时仍清理

- **WHEN** 评测过程中发生错误（超时、OOM 等）
- **THEN** 临时目录及其内容仍被删除

### Requirement: 并发控制

系统 SHALL
通过统一容器池控制并发评测数。所有容器（预创建和即时创建）均通过池管理，无独立
Semaphore。

#### Scenario: 达到并发上限

- **WHEN** `in_flight >= POOL_MAX_SIZE`
- **THEN** 新任务在 acquire 处阻塞等待，直到有容器释放

#### Scenario: 并发任务完成释放

- **WHEN** 某个评测任务完成（无论成功或失败）
- **THEN** `in_flight` 计数器 -1，容器被删除
- **THEN** 阻塞等待的任务解除阻塞执行

### Requirement: 临时文件管理

系统 SHALL 为每个评测任务创建独立临时目录
`{WORK_DIR}/{submission_id}/`，评测完成后清理。此路径与池容器文件注入配合使用——目录被
tar 打包后上传到容器 `/tmp/`。

#### Scenario: 创建临时目录

- **WHEN** 开始处理评测任务
- **THEN** 在 WORK_DIR 下创建以 submission_id 命名的子目录

#### Scenario: 清理临时目录

- **WHEN** 评测完成或发生错误
- **THEN** 删除该任务的临时目录及其所有内容
