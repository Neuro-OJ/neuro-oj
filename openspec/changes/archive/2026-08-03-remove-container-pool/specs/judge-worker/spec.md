## MODIFIED Requirements

### Requirement: 评测编排

系统 SHALL 依序执行：解析 `download_url`（host 分派：`base64` 或 `s3`）→ **优先尝试缓存** → 获取支持包 → 完整性校验 → 解压 → 写入用户代码 → 即时创建双容器（Evaluator + Solution）→ tar 打包 → docker exec 注入 → docker exec 评测 → 解析输出 → RAII 清理容器。评测容器每次即时创建、用后即毁，不再有容器池复用。

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
- **THEN** zip 条目数不超过 1000
- **THEN** 单文件大小不超过 64 MiB
- **THEN** 解压后总大小不超过 512 MiB
- **THEN** 拒绝 overlapping entries（相同路径重复）
- **THEN** 拒绝包含 `..` 组件的 entry

#### Scenario: 临时目录在错误时仍清理

- **WHEN** 评测过程中发生错误（超时、OOM 等）
- **THEN** 临时目录及其内容仍被删除

### Requirement: 临时文件管理

系统 SHALL 为每个评测任务创建独立临时目录
`{WORK_DIR}/{submission_id}/`，评测完成后清理。此路径与双容器文件注入配合使用——目录被
tar 打包后注入到容器的 `/workspace`。

#### Scenario: 创建临时目录

- **WHEN** 开始处理评测任务
- **THEN** 在 WORK_DIR 下创建以 submission_id 命名的子目录

#### Scenario: 清理临时目录

- **WHEN** 评测完成或发生错误
- **THEN** 删除该任务的临时目录及其所有内容

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

#### Scenario: 单容器回退（仅在 runtime_config 缺失时）

- **WHEN** `problems.runtime_config IS NULL`
- **THEN** 走单容器路径，使用 `judge_image` / `judge_command` 字段
- **WHEN** `problems.runtime_config IS NOT NULL`
- **THEN** 走 dual 路径，忽略 `judge_image` / `judge_command`（仅保留显示）
