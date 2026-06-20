## Purpose

定义 noj-judge（Rust 评测 Worker）的核心功能规范。judge-worker
通过 Redis MQ 接收评测任务，在 Docker 容器中执行用户代码，
解析评分脚本的输出，并将结果返回给 noj-core。

## Requirements

### Requirement: 任务拉取

系统 SHALL 通过 BRPOP 命令从 `noj:judge:queue` 列表阻塞拉取评测任务，超时时间 5 秒。

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

系统 SHALL 将评测结果序列化为 JSON 后通过 LPUSH 推送到 `noj:judge:results` 列表，供 noj-core 消费。

#### Scenario: 成功发布结果

- **WHEN** 评测完成并组装 JudgeResult
- **THEN** 系统将结果 JSON LPUSH 到 `noj:judge:results`，日志记录 submission_id

#### Scenario: 发布失败

- **WHEN** Redis 连接断开导致 LPUSH 失败
- **THEN** 系统记录错误日志（结果丢失，后续用 Streams 改进）

### Requirement: 评测编排

系统 SHALL 依序执行：获取支持包（Base64 解码）→ 解压 → 写入用户代码 → 启动 Docker 容器 → 解析输出 → 清理临时目录。

#### Scenario: 评测成功

- **WHEN** Docker 容器正常退出且 stdout 包含 `---RESULT---` 标记
- **THEN** 系统解析标记后的 JSON，提取 status / score / details 组装 JudgeResult

#### Scenario: 评测超时

- **WHEN** 容器运行时间超过 time_limit_ms + 5 秒
- **THEN** 系统强制 kill 容器，status 设为 `TimeLimitExceeded`，score 设为 0

#### Scenario: 评测脚本无有效输出

- **WHEN** 容器退出但 stdout 中没有 `---RESULT---` 标记，且退出码为 0
- **THEN** status 设为 `SystemError`（评测脚本/环境异常，非用户代码问题），output 保留完整 stdout/stderr

#### Scenario: 用户代码运行时错误

- **WHEN** 容器退出但 stdout 中没有 `---RESULT---` 标记，且退出码非 0
- **THEN** status 设为 `RuntimeError`，output 保留完整 stdout/stderr

#### Scenario: 容器内存超限

- **WHEN** 容器因 OOM 被 Docker kill（退出码 137）
- **THEN** status 设为 `MemoryLimitExceeded`，score 设为 0

#### Scenario: 容器创建失败（镜像问题）

- **WHEN** task.judge_image 对应的镜像在本地不存在且无法构建
- **THEN** 评测返回 SystemError，错误信息包含镜像名和构建提示

#### Scenario: 临时目录在错误时仍清理

- **WHEN** 评测过程中发生错误（超时、OOM 等）
- **THEN** 临时目录及其内容仍被删除

### Requirement: 并发控制

系统 SHALL 通过可配置的信号量限制同时执行的评测数量，默认值为 2。

#### Scenario: 达到并发上限

- **WHEN** 当前已有 MAX_CONCURRENT 个任务在处理中
- **THEN** 主循环等待 permit 释放后才拉取新任务

#### Scenario: 并发任务完成释放

- **WHEN** 某个评测任务完成（无论成功或失败）
- **THEN** 信号量 permit 释放，主循环可以拉取新任务

### Requirement: 临时文件管理

系统 SHALL 为每个评测任务创建独立临时目录 `{WORK_DIR}/{submission_id}/`，评测完成后清理。

#### Scenario: 创建临时目录

- **WHEN** 开始处理评测任务
- **THEN** 在 WORK_DIR 下创建以 submission_id 命名的子目录

#### Scenario: 清理临时目录

- **WHEN** 评测完成或发生错误
- **THEN** 删除该任务的临时目录及其所有内容
