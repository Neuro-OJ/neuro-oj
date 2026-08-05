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

- **WHEN** Evaluator SDK 调用 `SolutionRunner.call(fn, ...args, timeout_ms?)`
- **THEN** SDK 通过 stdout 输出一行 NDJSON 帧 `{type: 'call', id, fn, args}`（可含可选 `timeout_ms` 字段）
- **THEN** judge 读取 evaluator exec stdout 中的 NDJSON 帧，登记调用级超时后原样转发到 solution host stdin
- **THEN** Solution host 处理后通过 stdout 输出 `result` 或 `error` 帧
- **THEN** judge 按 id 命中判定后把响应帧原样回写到 evaluator exec stdin（迟到/未知响应丢弃）
- **THEN** SDK 从 stdin 读到响应帧后阻塞调用返回

#### Scenario: 多次调用复用同一 Solution host

- **WHEN** 一次评测内多次调用 `SolutionRunner.call()`
- **THEN** 全部调用复用同一 Solution host 进程（persistent 模式）
- **THEN** Solution host 内的全局状态在调用之间持续存在
- **WHEN** `runner.restart()` 被调用
- **THEN** judge 关闭旧 Solution host 进程，启动新 host 进程

#### Scenario: 单次调用超时（调用级 timeout_ms）

- **WHEN** 某次 `runner.call()` 超过其生效超时（调用级 `timeout_ms` 或题目级默认 `runtime_config.solution.call_timeout_ms`）
- **THEN** judge 向 evaluator 写 `code: 'Timeout'` 错误帧
- **THEN** SDK 收到 Timeout 错误并抛出 `SolutionTimeoutError`
- **THEN** 该调用 id 的迟到响应被 judge 丢弃
- **THEN** Solution host 进程继续运行（不退出）

#### Scenario: Evaluator 总时间超时

- **WHEN** Evaluator 容器总执行时间超过 `runtime_config.evaluator.time_limit_ms`
- **THEN** judge `docker stop -t kill_grace_secs` Evaluator 容器
- **THEN** judge `docker kill` Evaluator 容器（如未退）

### Requirement: NDJSON 协议帧类型与字段

系统 SHALL 在 Evaluator / Solution 容器之间传输 NDJSON 帧，定义统一的帧类型与字段。

#### Scenario: 帧类型枚举

- **WHEN** 任何容器发送 NDJSON 帧
- **THEN** `type` 字段必须是下列之一：`ready` / `call` / `result` / `error` / `log` / `shutdown` / `cap_reg`
- **WHEN** `type` 为 `cap_reg`
- **THEN** 该帧为 evaluator → judge 私有协议（capability 默认超时上报），judge 不转发给 Solution Host
- **WHEN** `type` 为非法值
- **THEN** 接收方记录 warn 日志并丢弃该帧

#### Scenario: 错误码枚举

- **WHEN** `type === 'error'`
- **THEN** `code` 字段必须是下列之一：`Timeout` / `NotFound` / `Exception` / `SystemError` / `Rejected`

#### Scenario: 类型安全序列化

- **WHEN** Evaluator SDK 序列化 `runner.call()` 参数
- **THEN** 仅接受 `None` / `bool` / `int` / `float` / `str` / `bytes` / `list` / `dict` 七种类型
- **WHEN** 参数包含其他类型（如自定义类、函数、模块、socket、生成器）
- **THEN** Solution host 抛 `code: 'Rejected'`，host 进程继续运行

#### Scenario: Trace 路径清洗

- **WHEN** Solution host 格式化用户代码异常的 traceback
- **THEN** 仅保留文件 basename + 行号 + 类名 + 消息
- **THEN** 剥离所有绝对路径（不暴露 SDK 安装路径或容器镜像 layout）

### Requirement: 时间层级关系

系统 SHALL 明确 Evaluator / Solution / SDK 调用三层时间约束的语义。

#### Scenario: 时间约束分层

- **WHEN** dual mode 评测启动
- **THEN** 单次 `runner.call()` 受调用级 `timeout_ms` 约束（缺省回退 `runtime_config.solution.call_timeout_ms` 默认值）
- **THEN** `runtime_config.evaluator.time_limit_ms` 约束 Evaluator 容器总时间（含全部 SDK 调用）
- **THEN** 评测实际总耗时 = sum(SDK 调用耗时) + overhead，且 ≤ `evaluator.time_limit_ms`
- **THEN** `result.accept/wrong_answer` 调用本身不受调用超时限制

#### Scenario: 单次超时不影响 host

- **WHEN** 单次 `runner.call()` 超过其生效超时
- **THEN** judge 向 evaluator 写 Timeout 错误帧，SDK 收到 Timeout 错误
- **THEN** Solution host 进程继续运行，下一次 `runner.call()` 可正常执行
