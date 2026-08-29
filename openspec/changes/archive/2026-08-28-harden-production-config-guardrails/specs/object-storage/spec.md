## MODIFIED Requirements

### Requirement: S3StorageProvider

系统 SHALL 提供 `S3StorageProvider` 实现 `StorageProvider` 接口，用于生产环境。

`S3StorageProvider` SHALL：
- `put(key, data, contentType?)`: 将数据上传到 S3/MinIO，返回 `noj-storage://s3/<key>?checksum_sha256=<hex>`
- `get(url)`: 从 S3 下载数据
- `delete(url)`: 从 S3 删除对象
- `downloadUrl(url, expiresInSec?)`: 生成 presigned GET URL，percent 编码后返回 `noj-download://s3?url=[encoded-url]&checksum_sha256=<hex>`

生产配置通过 `S3_ENDPOINT`、`S3_REGION`、`S3_ACCESS_KEY`、`S3_SECRET_KEY`、`S3_BUCKET` 提供，且应用凭据 MUST 是目标 bucket 的最小权限凭据，不得使用对象存储 root 管理凭据。

#### Scenario: S3 模式实现

- **WHEN** `STORAGE_PROVIDER=s3` 且 S3 环境变量已配置
- **THEN** `createStorageProvider()` 返回 `S3StorageProvider` 实例

#### Scenario: 生产环境禁止 local 模式

- **WHEN** `NOJ_ENV=production` 且 `STORAGE_PROVIDER` 不是 `s3`
- **THEN** 启动时抛出致命错误，服务不启动

#### Scenario: S3 配置缺失报错

- **WHEN** `STORAGE_PROVIDER=s3` 且 endpoint、访问密钥、秘密密钥或 bucket 任一未设置
- **THEN** 启动时抛出致命错误，服务不启动

#### Scenario: 应用凭据权限受限

- **WHEN** 生产 core 使用 S3 应用凭据访问支持包 bucket
- **THEN** 读写、删除和列举目标 bucket 成功，但不能执行 MinIO 管理操作或访问其他 bucket
