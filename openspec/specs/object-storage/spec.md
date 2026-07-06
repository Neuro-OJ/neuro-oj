## Purpose

定义抽象存储层 StorageProvider 接口及其 Local/S3 实现，为支持包存储和交付提供统一抽象。

## Requirements

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

### Requirement: LocalStorageProvider

系统 SHALL 提供 `LocalStorageProvider` 实现 `StorageProvider` 接口，用于开发环境。

`LocalStorageProvider` SHALL：
- `put(data)`: 将数据 base64 编码，通过内容寻址生成 `noj-storage://local/<base64>?checksum_sha256=<hex>`
- `get(url)`: 从 URL 提取 base64 内容并解码
- `delete(url)`: 无操作（local 模式下存储于 URL 自身，无需删除文件）
- `downloadUrl(url)`: 复用 base64 内容，返回 `noj-download://base64/?content=<base64>&checksum_sha256=<hex>`

#### Scenario: local 模式实现

- **WHEN** `STORAGE_PROVIDER=local`
- **THEN** `createStorageProvider()` 返回 `LocalStorageProvider` 实例

### Requirement: S3StorageProvider

系统 SHALL 提供 `S3StorageProvider` 实现 `StorageProvider` 接口，用于生产环境。

`S3StorageProvider` SHALL：
- `put(key, data, contentType?)`: 将数据上传到 S3/MinIO，返回 `noj-storage://s3/<key>?checksum_sha256=<hex>`
- `get(url)`: 从 S3 下载数据
- `delete(url)`: 从 S3 删除对象
- `downloadUrl(url, expiresInSec?)`: 生成 presigned GET URL，percent 编码后返回 `noj-download://s3?url=[encoded-url]&checksum_sha256=<hex>`

配置通过环境变量：`S3_ENDPOINT`、`S3_REGION`、`S3_ACCESS_KEY`、`S3_SECRET_KEY`、`S3_BUCKET`。

#### Scenario: S3 模式实现

- **WHEN** `STORAGE_PROVIDER=s3` 且 S3 环境变量已配置
- **THEN** `createStorageProvider()` 返回 `S3StorageProvider` 实例

#### Scenario: S3 配置缺失报错

- **WHEN** `STORAGE_PROVIDER=s3` 但 `S3_ENDPOINT` 未设置
- **THEN** 启动时抛出致命错误，服务不启动
