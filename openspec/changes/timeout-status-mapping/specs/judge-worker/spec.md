## MODIFIED Requirements

### Requirement: 双容器评测编排（dual mode）

系统 SHALL 支持按题目一次任务启动 Evaluator + Solution 两个容器，按 NDJSON 协议在两个容器之间转发调用消息。

#### Scenario: 启动 Evaluator + Solution 双容器

- **WHEN** JudgeTask.mode === 'dual'
- **THEN** judge 启动 Evaluator 容器（网络隔离、不立即执行 evaluate.py）
- **THEN** judge 通过 `docker exec tar xf` 注入支持包文件到 Evaluator 容器的 `/workspace` 目录
- **THEN** judge 启动 Solution 容器（无网络、无支持包、不传 Evaluator 环境变量）
- **THEN** judge 通过 docker exec 在 Evaluator 容器内运行 `runtime_config.evaluator.command`
- **THEN** judge 通过 docker exec 在 Solution 容器内运行 `python3 -m noj_solution_sdk.host --entry <solution.entry>`
- **THEN** Solution host 启动后 5 秒内必须发送 `ready` 帧，否则判 SystemError

#### Scenario: NDJSON 帧转发（Evaluator → Solution）

- **WHEN** Evaluator SDK 调用 `SolutionRunner.call(fn, ...args)`
- **THEN** SDK 通过 stdout 输出一行 NDJSON 帧 `{type: 'call', id, fn, args}`
- **THEN** judge 读取 evaluator exec stdout 中的 NDJSON 帧，原样转发到 solution host stdin
- **THEN** Solution host 处理后通过 stdout 输出 `result` 或 `error` 帧
- **THEN** judge 读取 solution exec stdout 中的响应帧，原样回写到 evaluator exec stdin
- **THEN** SDK 从 stdin 读到响应帧后阻塞调用返回

#### Scenario: 多次调用复用同一 Solution host

- **WHEN** 一次评测内多次调用 `SolutionRunner.call()`
- **THEN** 全部调用复用同一 Solution host 进程（persistent 模式）
- **THEN** Solution host 内的全局状态在调用之间持续存在
- **WHEN** `runner.restart()` 被调用
- **THEN** judge 关闭旧 Solution host 进程，启动新 host 进程

#### Scenario: 单次调用超时（call_timeout_ms）

- **WHEN** 某次 `runner.call()` 超过 `runtime_config.solution.call_timeout_ms`（或调用级 `timeout_ms`）
- **THEN** judge 停止向 solution host stdin 写入
- **THEN** SDK 收到 `code: 'CallTimeout'` 错误帧（抛 `SolutionTimeoutError`）
- **THEN** Solution host 进程继续运行（不退出）
- **WHEN** evaluator 未捕获 `SolutionTimeoutError`（evaluate.py 异常退出、未输出 `---RESULT---`）
- **THEN** JudgeResult.status = 'TimeLimitExceeded'
- **WHEN** evaluator 捕获 `SolutionTimeoutError` 并记为失败用例
- **THEN** 最终状态由 evaluator 决定（如 `WrongAnswer`）

#### Scenario: Evaluator 总时间超时

- **WHEN** Evaluator 容器总执行时间超过 `runtime_config.evaluator.time_limit_ms`
- **THEN** judge `docker stop -t kill_grace_secs` Evaluator 容器
- **THEN** judge `docker kill` Evaluator 容器（如未退）
- **THEN** judge `docker rm -f` Solution 容器
- **THEN** JudgeResult.status = 'SystemError'

#### Scenario: Evaluator 启动超时

- **WHEN** Evaluator 启动等待超过宽松上限（容器创建 / 文件注入 / 运行时启动开销，不计入题目时限）
- **THEN** judge 强制终止评测
- **THEN** JudgeResult.status = 'SystemError'

#### Scenario: Evaluator OOM

- **WHEN** Evaluator 容器因 RSS 超限被 Docker kill（退出码 137）
- **THEN** JudgeResult.status = 'MemoryLimitExceeded'

#### Scenario: Solution OOM

- **WHEN** Solution 容器 RSS 超 `runtime_config.solution.memory_limit_mb`
- **THEN** Solution host 守护进程触发 SystemError
- **THEN** judge 关闭 Solution 容器 + Evaluator 容器
- **THEN** JudgeResult.status = 'SystemError'

### Requirement: NDJSON 协议帧类型与字段

系统 SHALL 在 Evaluator / Solution 容器之间传输 NDJSON 帧，定义统一的帧类型与字段。

#### Scenario: 帧类型枚举

- **WHEN** 任何容器发送 NDJSON 帧
- **THEN** `type` 字段必须是下列之一：`ready` / `call` / `result` / `error` / `log` / `shutdown`
- **WHEN** `type` 为非法值
- **THEN** 接收方记录 warn 日志并丢弃该帧

#### Scenario: 错误码枚举

- **WHEN** `type === 'error'`
- **THEN** `code` 字段必须是下列之一：`CallTimeout` / `NotFound` / `Exception` / `SystemError` / `Rejected`

#### Scenario: 类型安全序列化

- **WHEN** Evaluator SDK 序列化 `runner.call()` 参数
- **THEN** 仅接受 `None` / `bool` / `int` / `float` / `str` / `bytes` / `list` / `dict` 七种类型
- **WHEN** 参数包含其他类型（如自定义类、函数、模块、socket、生成器）
- **THEN** Solution host 抛 `code: 'Rejected'`，host 进程继续运行

#### Scenario: Trace 路径清洗

- **WHEN** Solution host 格式化用户代码异常的 traceback
- **THEN** 仅保留文件 basename + 行号 + 类名 + 消息
- **THEN** 剥离所有绝对路径（不暴露 SDK 安装路径或容器镜像 layout）
