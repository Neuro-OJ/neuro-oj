## ADDED Requirements

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

- **WHEN** 某次 `runner.call()` 超过 `runtime_config.solution.call_timeout_ms`
- **THEN** judge 停止向 solution host stdin 写入
- **THEN** SDK 收到 `code: 'Timeout'` 错误帧
- **THEN** Solution host 进程继续运行（不退出）

#### Scenario: Evaluator 总时间超时

- **WHEN** Evaluator 容器总执行时间超过 `runtime_config.evaluator.time_limit_ms`
- **THEN** judge `docker stop -t kill_grace_secs` Evaluator 容器
- **THEN** judge `docker kill` Evaluator 容器（如未退）
- **THEN** judge `docker rm -f` Solution 容器
- **THEN** JudgeResult.status = 'TimeLimitExceeded'

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

### Requirement: Log 消息限额

系统 SHALL 对 Solution host 上报的 `log` 帧实施双限额，防止日志 spam 拖慢评测或撑爆 JudgeResult。

#### Scenario: 单条 log 限额

- **WHEN** Solution host 发送 `log` 帧
- **THEN** `data` 字段长度 ≤ 64 KiB
- **WHEN** 超过 64 KiB
- **THEN** 截断为前 64 KiB + `\n<truncated>\n`

#### Scenario: 累计 log 限额

- **WHEN** 单次评测累计 `log.data` 字节数 ≤ 1 MiB
- **THEN** 所有 log 帧正常上报
- **WHEN** 累计超过 1 MiB
- **THEN** 后续 log 帧被 judge 丢弃
- **THEN** JudgeResult.details.logs_dropped 字段记录丢弃数量

#### Scenario: Log 不进入 output 字段

- **WHEN** log 帧累计并入 JudgeResult
- **THEN** 仅写入 `details.logs[]`，不进入 `output` 字段
- **THEN** `details.logs` 单独 8 KiB 截断

### Requirement: 输出缓冲约定

系统 SHALL 要求 SDK / host 启动时配置 line buffering，避免 NDJSON 帧在管道 block buffering 下卡住。

#### Scenario: Solution host line buffering

- **WHEN** Solution host 启动
- **THEN** host 调用 `sys.stdout.reconfigure(line_buffering=True)`
- **THEN** host 调用 `sys.stderr.reconfigure(line_buffering=True)`

#### Scenario: Evaluator SDK stdout 纯净

- **WHEN** `noj_evaluator_sdk.configure_logging()` 被调用
- **THEN** 所有 SDK 内部 print / logging 重定向到 stderr
- **THEN** evaluate.py 自身 print 仍可能污染 stdout（设计选择：不强制重定向，文档警示）

### Requirement: 容器清理 RAII 契约

系统 SHALL 使用 RAII 保证双容器在所有错误场景下都被清理。

#### Scenario: DualContainer Drop 顺序

- **WHEN** DualContainer 被 drop（无论正常路径还是 panic）
- **THEN** 先 `docker rm -f` Solution 容器
- **THEN** 后 `docker rm -f` Evaluator 容器
- **THEN** 中间任何步骤抛错不阻止后续清理
- **THEN** 临时目录与下载缓存被清理

#### Scenario: 8 种错误场景必测

- **WHEN** orchestrator 单元/集成测试运行
- **THEN** 覆盖以下 8 种场景的清理正确性：evaluator 启动失败、solution 启动失败、evaluator exec 启动失败、solution host 未 ready、SDK 调用超时、SDK 反序列化错误、evaluator 总超时、Solution OOM

### Requirement: 时间层级关系

系统 SHALL 明确 Evaluator / Solution / SDK 调用三层时间约束的语义。

#### Scenario: 时间约束分层

- **WHEN** dual mode 评测启动
- **THEN** `runtime_config.solution.call_timeout_ms` 约束单次 `runner.call()`
- **THEN** `runtime_config.evaluator.time_limit_ms` 约束 Evaluator 容器总时间（含全部 SDK 调用）
- **THEN** 评测实际总耗时 = sum(SDK 调用耗时) + overhead，且 ≤ `evaluator.time_limit_ms`
- **THEN** `result.accept/wrong_answer` 调用本身不受 `call_timeout_ms` 限制

#### Scenario: 单次超时不影响 host

- **WHEN** 单次 `runner.call()` 超 `call_timeout_ms`
- **THEN** judge 关闭转发通道，SDK 收到 Timeout 错误
- **THEN** Solution host 进程继续运行，下一次 `runner.call()` 可正常执行

### Requirement: 兼容性回退

系统 SHALL 在 runtime_config 缺失或镜像被下架时给出明确错误而非静默回退单容器。

#### Scenario: 镜像白名单校验（admin）

- **WHEN** admin 调用题目 CRUD API 设置 `runtime_config`
- **THEN** `runtime_config.evaluator.image` 必须在 `judge_images` 白名单中且 `kind='evaluator'`
- **THEN** `runtime_config.solution.image` 必须在 `judge_images` 白名单中且 `kind='solution'`
- **WHEN** 任何 image 不满足
- **THEN** API 返回 HTTP 400，提示 `image_not_allowlisted`

#### Scenario: 镜像白名单校验（core 调度 final gate）

- **WHEN** submissions service 推 MQ 前
- **THEN** 再次读取白名单确认镜像仍可用且 kind 匹配
- **WHEN** 镜像被下架或 kind 被改
- **THEN** 返回 `image_not_allowlisted` 错误，不悄悄回退单容器

#### Scenario: 镜像白名单校验（judge 防御）

- **WHEN** judge 准备创建 Evaluator / Solution 容器前
- **THEN** judge 校验本地缓存的镜像列表（防御 TOCTOU）
- **WHEN** 镜像不在本地缓存
- **THEN** 判 SystemError + 提示 `image_not_in_local_cache`

#### Scenario: 单容器回退（仅在 runtime_config 缺失时）

- **WHEN** `problems.runtime_config IS NULL`
- **THEN** 走单容器路径，使用 `judge_image` / `judge_command` 字段
- **WHEN** `problems.runtime_config IS NOT NULL`
- **THEN** 走 dual 路径，忽略 `judge_image` / `judge_command`（仅保留显示）

## REMOVED Requirements

无（不删除既有单容器需求，仅扩展 dual 模式）。