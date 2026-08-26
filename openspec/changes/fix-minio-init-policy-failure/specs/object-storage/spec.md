## MODIFIED Requirements

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

### Requirement: 生产 MinIO 初始化失败必须阻止依赖服务启动

生产部署的对象存储初始化 MUST 在 bucket 创建、策略创建、应用用户创建或策略绑定任一操作失败时以非零状态退出。依赖该初始化成功的 core 服务 MUST NOT 被判定为可启动；初始化过程 MUST 不依赖目标镜像未提供的外部工具。

#### Scenario: policy 创建失败

- **WHEN** MinIO 初始化无法创建或更新 bucket-scoped 应用 policy
- **THEN** 初始化任务返回非零状态，core 不因错误的成功状态而启动

#### Scenario: 初始化成功

- **WHEN** MinIO 初始化成功创建目标 bucket、应用用户和 bucket-scoped policy
- **THEN** 初始化任务返回零状态，应用凭据能够读写目标 bucket 且不能访问其他 bucket 或 MinIO 管理接口
