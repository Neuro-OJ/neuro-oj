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

JudgeTask SHALL 使用 `download_url` 替代 `support_package_base64`（字段更名，语意更清晰）：

- `download_url?: string` — 格式为 `noj-download://` 的自包含 URL，携带下载方式和 `checksum_sha256`
  - `noj-download://base64/?content=[base64]&checksum_sha256=...` — 内嵌 base64 内容
  - `noj-download://s3?url=[percent-encoded-presigned-URL]&checksum_sha256=...` — 引用远程 URL

该 URL **自包含完整性校验哈希**，judge 无需额外字段即可校验和缓存。

#### Scenario: JudgeTask 携带 download_url

- **WHEN** noj-core 构建 JudgeTask
- **THEN** `download_url` 存在且以 `noj-download://` 开头
- **THEN** URL 中包含 `checksum_sha256` query 参数

### Requirement: 评测编排

系统 SHALL 依序执行：从池获取容器 → 解析 `download_url`（host 分派：`base64` 或 `s3`）→ **优先尝试缓存** → 获取支持包 → 完整性校验 → 解压 → 写入用户代码 → tar 打包 → docker exec 注入 → docker exec 评测 → 解析输出 → 释放容器。

#### Scenario: 评测成功（s3 模式）

- **WHEN** `download_url` 为 `"noj-download://s3?url=http%3A%2F%2Fminio...&checksum_sha256=abc123..."`
- **WHEN** 系统 percent 解码 `url` 参数得到 presigned HTTP URL
- **WHEN** HTTP GET 成功下载支持包 zip
- **WHEN** SHA-256 校验通过
- **THEN** 缓存写入 `{cache_dir}/abc123....zip`
- **THEN** 解压、执行评测、返回结果

#### Scenario: 评测成功（base64 模式）

- **WHEN** `download_url` 为 `"noj-download://base64/?content=UEsDBBQAAAAI...&checksum_sha256=abc123..."`
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

#### Scenario: 评测超时

- **WHEN** exec 运行时间超过 `time_limit_ms + kill_grace_secs × 1000` ms
- **THEN** 系统有序终止（`docker stop -t <kill_grace_secs>` → `docker kill`）
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

- **WHEN** task.judge_image 对应的镜像在本地不存在且拉取失败
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

系统 SHALL 通过固定大小容器池控制并发评测数。

#### Scenario: 无空闲容器时即时创建

- **WHEN** 空闲队列为空
- **THEN** 系统即时创建新容器并分配
- **THEN** 池中 InUse 容器数不超过 `POOL_MAX_SIZE`

#### Scenario: 并发任务完成释放

- **WHEN** 某个评测任务完成（无论成功或失败）
- **THEN** `in_flight` 计数器 -1，容器被删除
- **THEN** 新容器被创建并回补到空闲队列

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

缓存键 MUST 为 `download_url` 中 `checksum_sha256` 的值（内容寻址，SHA-256 算法唯一固定）。

缓存文件路径 SHALL 为 `{SUPPORT_CACHE_DIR}/{checksum_sha256}.zip`。

缓存目录 SHALL 通过 `SUPPORT_CACHE_DIR` 环境变量配置（默认 `/tmp/noj-judge/support-cache`）。`SUPPORT_CACHE_MAX_ITEMS` 控制最大文件数（默认 500），`SUPPORT_CACHE_MAX_MB` 控制最大磁盘占用（默认 2048）。

超出上限时 SHALL 按 LRU 策略淘汰（删除 `atime` 最旧的文件）。

#### Scenario: 缓存命中

- **WHEN** `checksum_sha256` 为 `"abc123..."`，缓存文件 `{SUPPORT_CACHE_DIR}/abc123....zip` 已存在
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

系统 SHALL 在写入新缓存文件时检查当前缓存文件数量是否超过 `SUPPORT_CACHE_MAX_ITEMS` 或总大小是否超过 `SUPPORT_CACHE_MAX_MB`，超出时根据访问时间（`atime`）淘汰最久未访问的文件。

#### Scenario: 超过最大文件数时淘汰

- **WHEN** 缓存目录已有 500 个文件
- **WHEN** 需要写入第 501 个缓存文件
- **THEN** 系统删除至少一个 `atime` 最早的文件后写入新文件
