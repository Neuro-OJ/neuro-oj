## REMOVED Requirements

### Requirement: Base64 支持包解码

**Reason**: JudgeTask 移除 `support_package_base64` 字段，统一使用 `download_url`（`noj-download://` URL）。项目处于开发阶段，无需向后兼容。
**Migration**: noj-core 在构建 JudgeTask 时始终填充 `download_url`；noj-judge 根据 URL host 分派处理方式。

## MODIFIED Requirements

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

## ADDED Requirements

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
