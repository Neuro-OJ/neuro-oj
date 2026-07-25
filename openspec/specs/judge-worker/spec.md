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

### Requirement: JudgeTask 结构

JudgeTask SHALL 使用 `download_url` 替代
`support_package_base64`（字段更名，语意更清晰）：

- `download_url?: string` — 格式为 `noj-download://` 的自包含
  URL，携带下载方式和 `checksum_sha256`
  - `noj-download://base64/?content=[base64]&checksum_sha256=...` — 内嵌 base64
    内容
  - `noj-download://s3?url=[percent-encoded-presigned-URL]&checksum_sha256=...`
    — 引用远程 URL

该 URL **自包含完整性校验哈希**，judge 无需额外字段即可校验和缓存。

#### Scenario: JudgeTask 携带 download_url

- **WHEN** noj-core 构建 JudgeTask
- **THEN** `download_url` 存在且以 `noj-download://` 开头
- **THEN** URL 中包含 `checksum_sha256` query 参数

### Requirement: 评测编排

系统 SHALL 依序执行：从池获取容器 → 解析 `download_url`（host 分派：`base64` 或
`s3`）→ **优先尝试缓存** → 获取支持包 → 完整性校验 → 解压 → 写入用户代码 → tar
打包 → docker exec 注入 → docker exec 评测 → 解析输出 → 释放容器。

#### Scenario: 评测成功（s3 模式）

- **WHEN** `download_url` 为
  `"noj-download://s3?url=http%3A%2F%2Fminio...&checksum_sha256=abc123..."`
- **WHEN** 系统 percent 解码 `url` 参数得到 presigned HTTP URL
- **WHEN** HTTP GET 成功下载支持包 zip
- **WHEN** SHA-256 校验通过
- **THEN** 缓存写入 `{cache_dir}/abc123....zip`
- **THEN** 解压、执行评测、返回结果

#### Scenario: 评测成功（base64 模式）

- **WHEN** `download_url` 为
  `"noj-download://base64/?content=UEsDBBQAAAAI...&checksum_sha256=abc123..."`
- **WHEN** 系统解码 base64 得到 zip 字节
- **WHEN** SHA-256 校验通过
- **THEN** 缓存写入 `{cache_dir}/abc123....zip`
- **THEN** 解压、执行评测、返回结果

#### Scenario: 无支持包时跳过

- **WHEN** `download_url` 不存在或为空
- **THEN** 系统跳过支持包获取和解压步骤，直接写入用户代码
- **THEN** 评测正常进行

#### Scenario: 下载/解码失败返回 SystemError

- **WHEN** s3 模式 HTTP 下载失败（连接超时、403 等）
- **WHEN** 或 base64 模式解码失败（非法 base64 字符串）
- **THEN** status 设为 `SystemError`，输出包含失败原因
- **THEN** 不进行后续评测步骤

#### Scenario: 完整性校验失败

- **WHEN** 获得 zip 字节后计算 SHA-256，与 `checksum_sha256` 不匹配
- **THEN** status 设为 `SystemError`，输出包含期望/实际哈希值
- **THEN** 不进行后续评测步骤
- **THEN** 清理本次写入的缓存文件（防止缓存中毒）

#### Scenario: 返回资源消耗数据（双容器）

- **WHEN** 评测完成（正常或异常）
- **THEN** `JudgeResult.time_ms` 包含 Evaluator 容器总执行时间（含全部 SDK 调用）
- **THEN** `JudgeResult.memory_kb` 包含 Evaluator RSS 峰值
- **THEN** Solution OOM 不计入上述字段（单独由 ADDED Requirements 中的 Solution OOM scenario 覆盖）
- **WHEN** 资源测量失败（如 cgroup 不可读）
- **THEN** `time_ms` 和 `memory_kb` 返回 0

#### Scenario: zip 解压防护

- **WHEN** 解压支持包 zip
- **THEN** 解压后总大小不超过 `POOL_MAX_ARCHIVE_MB`
- **THEN** 拒绝 overlapping entries（相同路径重复）
- **THEN** 拒绝包含 `..` 组件的 entry
- **THEN** 单文件大小不超过 `POOL_MAX_ARCHIVE_MB`

#### Scenario: 临时目录在错误时仍清理

- **WHEN** 评测过程中发生错误（超时、OOM 等）
- **THEN** 临时目录及其内容仍被删除

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

### Requirement: 支持包缓存

系统 SHOULD 在本地磁盘缓存支持包，避免同一支持包被重复下载或解码。

缓存键 MUST 为 `download_url` 中 `checksum_sha256` 的值（内容寻址，SHA-256
算法唯一固定）。

缓存文件路径 SHALL 为 `{SUPPORT_CACHE_DIR}/{checksum_sha256}.zip`。

缓存目录 SHALL 通过 `SUPPORT_CACHE_DIR` 环境变量配置（默认
`/tmp/noj-judge/support-cache`）。`SUPPORT_CACHE_MAX_ITEMS` 控制最大文件数（默认
500），`SUPPORT_CACHE_MAX_MB` 控制最大磁盘占用（默认 2048）。

超出上限时 SHALL 按 LRU 策略淘汰（删除 `atime` 最旧的文件）。

#### Scenario: 缓存命中

- **WHEN** `checksum_sha256` 为 `"abc123..."`，缓存文件
  `{SUPPORT_CACHE_DIR}/abc123....zip` 已存在
- **THEN** 系统直接读取缓存文件内容，跳过网络下载或 base64 解码
- **THEN** 评测正常进行

#### Scenario: 缓存未命中

- **WHEN** `checksum_sha256` 为 `"abc123..."`，缓存文件不存在
- **THEN** 系统通过 `download_url` 获取支持包
- **THEN** 校验通过后将内容写入 `{SUPPORT_CACHE_DIR}/abc123....zip`
- **THEN** 若超出 `MAX_ITEMS` 或 `MAX_MB`，按 LRU 淘汰旧缓存

#### Scenario: 无 checksum 时不缓存

- **WHEN** `download_url` 中无 `checksum_sha256` 参数
- **THEN** 系统跳过缓存，直接获取支持包

### Requirement: 缓存淘汰（LRU）

系统 SHALL 在写入新缓存文件时检查当前缓存文件数量是否超过
`SUPPORT_CACHE_MAX_ITEMS` 或总大小是否超过
`SUPPORT_CACHE_MAX_MB`，超出时根据访问时间（`atime`）淘汰最久未访问的文件。

#### Scenario: 超过最大文件数时淘汰

- **WHEN** 缓存目录已有 500 个文件
- **WHEN** 需要写入第 501 个缓存文件
- **THEN** 系统删除至少一个 `atime` 最早的文件后写入新文件

### Requirement: 双容器评测编排（dual mode）

系统 SHALL 支持按题目一次任务启动 Evaluator + Solution 两个容器，按 NDJSON
协议在两个容器之间转发调用消息。

#### Scenario: 启动 Evaluator + Solution 双容器

- **WHEN** JudgeTask 含 `runtime_config`
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

系统 SHALL 对 Solution host 上报的 `log` 帧实施双限额，防止日志 spam 拖慢评测
或撑爆 JudgeResult。

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

系统 SHALL 要求 SDK / host 启动时配置 line buffering，避免 NDJSON 帧在管道
block buffering 下卡住。

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

### Requirement: 镜像白名单防御（judge 侧）

系统 SHALL 在 judge 准备创建 Evaluator / Solution 容器前做最终校验，避免 TOCTOU。

#### Scenario: 镜像白名单校验（judge 防御）

- **WHEN** judge 准备创建 Evaluator / Solution 容器前
- **THEN** judge 校验本地缓存的镜像列表
- **WHEN** 镜像不在本地缓存
- **THEN** 判 SystemError + 提示 `image_not_in_local_cache`

### Requirement: runtime_config 必填校验

系统 SHALL 在题目创建/更新 API 与提交流程中要求 `runtime_config` 必填，
缺字段时返回明确错误。

#### Scenario: 创建/更新缺 runtime_config 被拒

- **WHEN** admin 创建或更新题目，`runtime_config` 缺失或缺任一必填字段
- **THEN** API 返回 HTTP 400，错误信息明确指出缺失字段
