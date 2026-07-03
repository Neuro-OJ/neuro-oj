## ADDED Requirements

### Requirement: StorageProvider 接口

系统 SHALL 定义 `StorageProvider` 抽象接口，包含以下方法：

- `put(key, data, contentType?)`: 存储数据，返回 `storage://` URL
- `get(url)`: 读取存储的数据，返回 `Uint8Array`
- `delete(url)`: 删除存储的数据
- `presignedUrl(url, expiresInSec?)`: 生成 judge 可用的下载 URL（S3 模式返回 presigned HTTPS URL；local 模式返回原 `storage://local/<base64>`）

所有实现 MUST 在 `put`/`get`/`delete` 失败时抛出明确的错误。

#### Scenario: put 返回 storage:// URL

- **WHEN** 调用 `storage.put("packages/123.zip", zipData)`
- **THEN** local 模式返回 `"storage://local/<base64>"`，S3 模式返回 `"storage://s3/packages/123.zip"`

#### Scenario: get 读取已存储数据

- **WHEN** 调用 `storage.get("storage://local/UEsDBBQAAAAI...")`（local 模式）
- **THEN** 解码 base64 返回原始 Uint8Array 数据

#### Scenario: delete 幂等

- **WHEN** 调用 `storage.delete(url)` 删除不存在的资源
- **THEN** 不抛出错误，静默返回

### Requirement: storage:// URL 格式

系统 SHALL 定义 `storage://` URL 格式用于标识存储资源：

- Local: `storage://local/<base64>` — base64 编码的数据直接嵌入 URL
- S3: `storage://s3/<key>` — 指向 S3 对象的引用（key 为 object key，如 `packages/123.zip`，bucket 来自配置）

系统 SHALL 提供 `parseStorageUrl(url)` 函数解析 `storage://` URL 返回 `{ scheme, key }`。输入非 `storage://` 前缀的值时返回 `null`（视为 legacy local path）。

#### Scenario: 解析 local URL

- **WHEN** 解析 `"storage://local/UEsDBBQAAAAI..."`
- **THEN** 返回 `{ scheme: "local", key: "UEsDBBQAAAAI..." }`

#### Scenario: 解析 S3 URL

- **WHEN** 解析 `"storage://s3/packages/123.zip"`
- **THEN** 返回 `{ scheme: "s3", key: "packages/123.zip" }`

#### Scenario: 解析非 storage URL 返回 null

- **WHEN** 解析 `"data/packages/old.zip"`（无 `storage://` 前缀）
- **THEN** `parseStorageUrl()` 返回 `null`，视为 legacy path

### Requirement: LocalStorageProvider

系统 SHALL 实现 `LocalStorageProvider`。

`put(key, data)` SHALL 将数据编码为 `storage://local/<base64>` 格式（数据自包含在 URL 中，不写入磁盘）。

`get(url)` SHALL 解析 `storage://local/<base64>`，提取并解码 base64 部分返回原始字节。`get()` MUST 支持 legacy path（无 `storage://` 前缀的值），将其视为相对于 CWD 的本地路径读取。

`presignedUrl(url)` SHALL 返回原 URL（数据已自包含，无需额外签名）。

LocalStorageProvider MUST 在首次实例化时向 stderr 输出废弃警告：
```
[storage/local] ⚠️  本地文件存储仅用于开发测试，不应在生产环境中使用。
[storage/local]    请设置 STORAGE_PROVIDER=s3 并配置 S3_ENDPOINT 以启用对象存储。
```

#### Scenario: put 编码为 storage://local/base64

- **WHEN** 调用 `storage.put("packages/123.zip", zipData)`
- **THEN** 返回 `storage://local/<base64-encoded-zipData>`（zip 数据的 base64 编码直接嵌入 URL）

#### Scenario: get 解码 storage://local/base64

- **WHEN** 调用 `storage.get("storage://local/UEsDBBQAAAAI...")`
- **THEN** 提取 `UEsDBBQAAAAI...` 部分，Base64 解码，返回原始字节

#### Scenario: 实例化输出废弃警告

- **WHEN** 创建 LocalStorageProvider 实例
- **THEN** 向 stderr 输出包含"本地文件存储仅用于开发测试"的中文警告

#### Scenario: get 读取 legacy path

- **WHEN** 调用 `storage.get("data/packages/old.zip")`（无 `storage://` 前缀）
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

S3StorageProvider 的 `presignedUrl()` SHALL 使用 `@aws-sdk/s3-request-presigner` 的 `getSignedUrl` 生成限时下载 URL，默认有效期 3600 秒。

S3StorageProvider SHOULD 在首次使用时调用 `HeadBucket` 验证 bucket 存在，不存在时尝试 `CreateBucket`（失败为非致命错误，仅记录警告）。

#### Scenario: put 存入 S3

- **WHEN** 调用 `storage.put("packages/123.zip", zipData, "application/zip")`
- **THEN** 通过 `PutObjectCommand` 将数据存入配置的 bucket
- **THEN** 返回 `"storage://s3/packages/123.zip"`

#### Scenario: presignedUrl 生成限时 URL

- **WHEN** 调用 `storage.presignedUrl("storage://s3/packages/123.zip", 3600)`
- **THEN** 解析 URL 提取 key `packages/123.zip`，调用 `getSignedUrl` 生成 presigned URL
- **THEN** 返回一个以 `http://` 或 `https://` 开头的签名 URL，有效期约 1 小时

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
