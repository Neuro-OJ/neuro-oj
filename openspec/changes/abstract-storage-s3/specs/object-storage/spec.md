## ADDED Requirements

### Requirement: StorageProvider 接口

系统 SHALL 定义 `StorageProvider` 抽象接口，包含以下方法：

- `put(key, data, contentType?)`: 存储数据，返回 `noj-storage://` URL（带 `?checksum_sha256=<hex>`）
- `get(url)`: 读取存储的数据，接受 `noj-storage://` URL，返回 `Uint8Array`
- `delete(url)`: 删除存储的数据，接受 `noj-storage://` URL
- `downloadUrl(url, expiresInSec?)`: 接受 `noj-storage://` URL，返回 `noj-download://` URL（供 judge 使用）

所有实现 MUST 在 `put`/`get`/`delete` 失败时抛出明确的错误。

`put()` MUST 在对数据进行存储前计算 SHA-256 哈希，将 `checksum_sha256=<hex>` 作为 query 参数附加到返回 URL。

`downloadUrl()` MUST 提取 `checksum_sha256` 并放入返回的 `noj-download://` URL 中。

#### Scenario: put 返回 noj-storage:// URL

- **WHEN** 调用 `storage.put("packages/123.zip", zipData)`
- **THEN** 计算 zipData 的 SHA-256 得到 hex 值 `abc123...`
- **THEN** local 模式返回 `"noj-storage://local/<base64>?checksum_sha256=abc123..."`
- **THEN** S3 模式返回 `"noj-storage://s3/packages/123.zip?checksum_sha256=abc123..."`

#### Scenario: downloadUrl 返回自包含的 noj-download:// URL

- **WHEN** 调用 `storage.downloadUrl("noj-storage://local/<base64>?checksum_sha256=abc123...", 3600)`
- **THEN** local 模式返回 `"noj-download://base64/?content=[base64]&checksum_sha256=abc123..."`
- **THEN** S3 模式生成 presigned URL，percent 编码后返回 `"noj-download://s3?url=[percent-encoded-presigned-URL]&checksum_sha256=abc123..."`

#### Scenario: get 读取已存储数据

- **WHEN** 调用 `storage.get("noj-storage://local/UEsDBBQAAAAI...?checksum_sha256=abc123...")`
- **THEN** 忽略 query 参数，解码 base64 返回原始 Uint8Array 数据

#### Scenario: delete 幂等

- **WHEN** 调用 `storage.delete(url)` 删除不存在的资源
- **THEN** 不抛出错误，静默返回

### Requirement: URL 两层空间

系统 SHALL 定义两层 URL 空间：

**`noj-storage://`** — DB 存储层，标识资源持久位置：

- `noj-storage://local/<base64>?checksum_sha256=<hex>` — 数据自包含在路径中
- `noj-storage://s3/<key>?checksum_sha256=<hex>` — 指向 S3 对象（key 为 object key，bucket 来自配置）

**`noj-download://`** — Judge 交付层，自包含下载方式和完整性校验：

- `noj-download://base64/?content=[base64]&checksum_sha256=<hex>` — base64 内容在 `content` 参数中
- `noj-download://s3?url=[percent-encoded-presigned-URL]&checksum_sha256=<hex>` — presigned HTTP URL 经 RFC 3986 百分号编码后放在 `url` 参数中（解决 URL 嵌套歧义）

| 层级 | local 模式 | S3 模式 |
|------|-----------|---------|
| **DB 存储** | `noj-storage://local/<base64>?checksum_sha256=...` | `noj-storage://s3/<key>?checksum_sha256=...` |
| **Judge 交付** | `noj-download://base64/?content=[base64]&checksum_sha256=...` | `noj-download://s3?url=[encoded-presigned-url]&checksum_sha256=...` |

### Requirement: LocalStorageProvider

系统 SHALL 实现 `LocalStorageProvider`。

`put(key, data)` SHALL 计算 data 的 SHA-256 哈希 hex，将数据 base64 编码为 `noj-storage://local/<base64>?checksum_sha256=<hex>`。

`get(url)` SHALL 解析 `noj-storage://local/<base64>`，忽略 query 参数，提取并解码 base64 部分返回原始字节。`get()` MUST 支持 legacy path（无 `noj-storage://` 前缀的值），将其视为相对于 CWD 的本地路径读取。

`downloadUrl(url)` SHALL 解析 URL 提取 base64 和 `checksum_sha256`，返回 `noj-download://base64/?content=[base64]&checksum_sha256=<hex>`。

LocalStorageProvider MUST 在首次实例化时向 stderr 输出废弃警告：
```
[storage/local] ⚠️  本地文件存储仅用于开发测试，不应在生产环境中使用。
[storage/local]    请设置 STORAGE_PROVIDER=s3 并配置 S3_ENDPOINT 以启用对象存储。
```

#### Scenario: put 计算 checksum 并编码

- **WHEN** 调用 `storage.put("packages/123.zip", zipData)`
- **THEN** 计算 zipData 的 SHA-256 得到 hex
- **THEN** 返回 `"noj-storage://local/<base64>?checksum_sha256=<hex>"`

#### Scenario: downloadUrl 构造 noj-download:// URL

- **WHEN** 调用 `storage.downloadUrl("noj-storage://local/UEsDBBQAAAAI...?checksum_sha256=abc123...")`
- **THEN** 提取 base64 `UEsDBBQAAAAI...` 和 checksum `abc123...`
- **THEN** 返回 `"noj-download://base64/?content=UEsDBBQAAAAI...&checksum_sha256=abc123..."`

#### Scenario: 实例化输出废弃警告

- **WHEN** 创建 LocalStorageProvider 实例
- **THEN** 向 stderr 输出包含"本地文件存储仅用于开发测试"的中文警告

#### Scenario: get 读取 legacy path

- **WHEN** 调用 `storage.get("data/packages/old.zip")`（无 `noj-storage://` 前缀）
- **THEN** 按相对路径 `data/packages/old.zip` 读取文件并返回内容

### Requirement: S3StorageProvider

系统 SHALL 实现 `S3StorageProvider`，使用 `@aws-sdk/client-s3` 与 S3 兼容服务交互。

S3StorageProvider MUST 从以下环境变量读取配置：
- `S3_ENDPOINT`（默认 `http://localhost:9000`）
- `S3_REGION`（默认 `us-east-1`）
- `S3_ACCESS_KEY`（默认 `minioadmin`）
- `S3_SECRET_KEY`（默认 `minioadmin`）
- `S3_BUCKET`（默认 `noj-support-packages`）
- `S3_FORCE_PATH_STYLE`（默认 `false`；MinIO 需要设为 `true`）

`put(key, data)` MUST 先计算 data 的 SHA-256 哈希 hex，再通过 `PutObjectCommand` 存入 S3，返回 `noj-storage://s3/<key>?checksum_sha256=<hex>`。

`downloadUrl(url)` SHALL：
1. 解析 URL 提取 key 和 `checksum_sha256`
2. 调用 `getSignedUrl` 生成 presigned HTTP URL
3. 将 presigned URL 经 RFC 3986 百分号编码
4. 返回 `"noj-download://s3?url=[encoded-url]&checksum_sha256=<hex>"`

S3StorageProvider SHOULD 在首次使用时调用 `HeadBucket` 验证 bucket 存在，不存在时尝试 `CreateBucket`（失败为非致命错误，仅记录警告）。

#### Scenario: put 存入 S3

- **WHEN** 调用 `storage.put("packages/123.zip", zipData, "application/zip")`
- **THEN** 计算 zipData 的 SHA-256 得到 hex
- **THEN** 通过 `PutObjectCommand` 将数据存入配置的 bucket
- **THEN** 返回 `"noj-storage://s3/packages/123.zip?checksum_sha256=<hex>"`

#### Scenario: downloadUrl 嵌套 presigned URL

- **WHEN** 调用 `storage.downloadUrl("noj-storage://s3/packages/123.zip?checksum_sha256=abc123...", 3600)`
- **THEN** 生成 presigned URL `"http://minio:9000/bucket/packages/123.zip?X-Amz-Signature=..."`
- **THEN** 将 presigned URL 做 percent-encoding
- **THEN** 返回 `"noj-download://s3?url=http%3A%2F%2Fminio%3A9000%2Fbucket%2Fpackages%2F123.zip%3FX-Amz-Signature%3D...&checksum_sha256=abc123..."`

#### Scenario: bucket 不存在时自动创建

- **WHEN** S3StorageProvider 首次使用且配置的 bucket 不存在
- **THEN** 自动调用 `CreateBucket` 创建
- **THEN** 创建失败时记录警告日志但不阻断启动

### Requirement: Provider 工厂函数

系统 SHALL 通过 `getStorageProvider()` 工厂函数返回 StorageProvider 单例。

工厂函数 MUST 读取 `STORAGE_PROVIDER` 环境变量（默认 `"local"`）决定实例化哪个实现。

系统 SHALL 提供 `resetStorageProvider()` 函数用于测试中重置单例状态。

#### Scenario: 默认使用 local provider

- **WHEN** 未设置 `STORAGE_PROVIDER` 环境变量
- **THEN** `getStorageProvider()` 返回 LocalStorageProvider 实例
- **THEN** stderr 输出废弃警告

#### Scenario: 环境变量选择 S3 provider

- **WHEN** `STORAGE_PROVIDER=s3` 且 S3 相关环境变量已正确配置
- **THEN** `getStorageProvider()` 返回 S3StorageProvider 实例
