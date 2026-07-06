## Purpose

定义 Neuro OJ 支持包上传管理规范。支持包是题目评测所需的外部文件集合（如测试用例、评测脚本等），通过上传 API 进行管理。

## Requirements

### Requirement: 支持包上传

系统 SHALL 提供 `POST /api/v1/problems/:id/support-package` 端点，接受 multipart/form-data 格式的 zip 文件上传，通过 StorageProvider 存储 zip 数据并更新数据库中 `support_package_storage_url` 字段。

存储路径格式取决于当前 `STORAGE_PROVIDER`：
- `STORAGE_PROVIDER=local`：`put()` 返回 `noj-storage://local/<base64>?checksum_sha256=<hex>`
- `STORAGE_PROVIDER=s3`：`put()` 返回 `noj-storage://s3/<key>?checksum_sha256=<hex>`

上传者 MUST 是题目所有者或管理员，否则返回 HTTP 403。

上传文件大小 MUST 不超过 128 MiB。

#### Scenario: 所有者上传支持包（local 模式）

- **WHEN** `STORAGE_PROVIDER=local`
- **WHEN** 题目所有者发送 `POST /api/v1/problems/:id/support-package`，携带有效的 `.zip` 文件
- **THEN** 系统通过 `LocalStorageProvider.put()` 计算 SHA-256 并编码 base64
- **THEN** 更新 `support_package_storage_url` 为 `"noj-storage://local/<base64>?checksum_sha256=<hex>"`，返回 HTTP 200

#### Scenario: 所有者上传支持包（S3 模式）

- **WHEN** `STORAGE_PROVIDER=s3`
- **WHEN** 题目所有者发送 `POST /api/v1/problems/:id/support-package`，携带有效的 `.zip` 文件
- **THEN** 系统通过 `S3StorageProvider.put()` 计算 SHA-256 并存入 S3
- **THEN** 更新 `support_package_storage_url` 为 `"noj-storage://s3/packages/<problem_id>.zip?checksum_sha256=<hex>"`，返回 HTTP 200

#### Scenario: 管理员为任意题目上传支持包

- **WHEN** 管理员发送 `POST /api/v1/problems/:id/support-package`，题目的 owner_id 非管理员本人
- **THEN** 系统仍允许上传，返回 HTTP 200

#### Scenario: 非所有者上传被拒

- **WHEN** 非所有者、非管理员的用户发送 `POST /api/v1/problems/:id/support-package`
- **THEN** 系统返回 HTTP 403

#### Scenario: 上传非 zip 文件被拒

- **WHEN** 用户上传文件的 Content-Type 非 zip 或文件扩展名非 `.zip`
- **THEN** 系统返回 HTTP 400，提示"仅支持 .zip 格式文件"

#### Scenario: 题目不存在

- **WHEN** 用户上传支持包至不存在的题目 ID
- **THEN** 系统返回 HTTP 404

#### Scenario: 替换已有支持包

- **WHEN** 题目已有支持包，所有者上传新文件
- **THEN** 系统重新计算 SHA-256，返回新的 `noj-storage://` URL（checksum 变化自动体现），返回 HTTP 200

### Requirement: 支持包删除

系统 SHALL 提供 `DELETE /api/v1/problems/:id/support-package` 端点，通过 StorageProvider 删除已上传的支持包并将 `support_package_storage_url` 设为 `null`。

删除者 MUST 是题目所有者或管理员。

#### Scenario: 删除支持包（local 模式）

- **WHEN** `STORAGE_PROVIDER=local`，路径为 `noj-storage://local/<base64>?checksum_sha256=...`
- **WHEN** 所有者发送 `DELETE /api/v1/problems/:id/support-package`
- **THEN** 系统将 `support_package_storage_url` 设为 `null`，返回 HTTP 200

#### Scenario: 删除支持包（S3 模式）

- **WHEN** `STORAGE_PROVIDER=s3`，路径为 `noj-storage://s3/packages/<problem_id>.zip?checksum_sha256=...`
- **WHEN** 所有者发送 `DELETE /api/v1/problems/:id/support-package`
- **THEN** 系统通过 `S3StorageProvider.delete()` 删除 S3 对象，`support_package_storage_url` 设为 `null`，返回 HTTP 200

#### Scenario: 删除不存在的支持包

- **WHEN** 题目尚无支持包，所有者发送 `DELETE /api/v1/problems/:id/support-package`
- **THEN** 系统返回 HTTP 200（幂等操作）

#### Scenario: 非所有者删除被拒

- **WHEN** 非所有者、非管理员的用户发送 `DELETE /api/v1/problems/:id/support-package`
- **THEN** 系统返回 HTTP 403

### Requirement: 支持包下载

系统 SHALL 提供 `GET /api/v1/problems/:id/support-package` 端点，允许题目所有者和管理员下载已上传的支持包 zip 文件。

**所有模式均通过 noj-core 代理返回文件内容**（S3/MinIO 可能位于内网，用户浏览器不可直接访问）。S3 模式下 core 通过 `S3StorageProvider.get()` 从 S3 下载数据再响应给客户端，而非 302 重定向。

下载者 MUST 是题目所有者或管理员，否则返回 HTTP 403。

#### Scenario: 下载支持包（S3 模式）

- **WHEN** `STORAGE_PROVIDER=s3`，路径为 `noj-storage://s3/packages/<problem_id>.zip?checksum_sha256=...`
- **WHEN** 所有者发送 `GET /api/v1/problems/:id/support-package`
- **THEN** 系统调用 `S3StorageProvider.get()` 从 S3 获取 zip 原始字节
- **THEN** 返回 HTTP 200，`Content-Type: application/zip`，`Content-Disposition: attachment`

#### Scenario: 下载支持包（local 模式）

- **WHEN** `STORAGE_PROVIDER=local`，路径为 `noj-storage://local/<base64>?checksum_sha256=...`
- **WHEN** 所有者发送 `GET /api/v1/problems/:id/support-package`
- **THEN** 系统调用 `LocalStorageProvider.get()` 解码 base64 返回原始 zip
- **THEN** 返回 HTTP 200，`Content-Type: application/zip`，`Content-Disposition: attachment`

#### Scenario: 无支持包时下载

- **WHEN** 用户请求下载尚无支持包的题目
- **THEN** 系统返回 HTTP 404

#### Scenario: 非所有者下载被拒

- **WHEN** 非所有者、非管理员的用户发送 `GET /api/v1/problems/:id/support-package`
- **THEN** 系统返回 HTTP 403

### Requirement: 支持包上传状态在题目详情中可见

系统 SHALL 在 `GET /api/v1/problems/:id` 响应中包含 `support_package_storage_url` 字段和派生的 `has_support_package` 布尔字段，表示题目当前是否有已上传的支持包。

#### Scenario: 获取有支持包的题目详情

- **WHEN** 用户请求 `GET /api/v1/problems/:id`，题目已设置 `support_package_storage_url`
- **THEN** 响应中 `data.support_package_storage_url` 为非 null 字符串，`data.has_support_package` 为 `true`

#### Scenario: 获取无支持包的题目详情

- **WHEN** 用户请求 `GET /api/v1/problems/:id`，题目 `support_package_storage_url` 为 null
- **THEN** 响应中 `data.support_package_storage_url` 为 null，`data.has_support_package` 为 `false`

### Requirement: 支持包文件结构规范

系统 SHALL 要求上传的支持包 zip 文件遵循以下结构：所有文件直接位于 zip 根层级，不包含顶级文件夹。

zip 内 MUST 包含 `evaluate.py`（评测脚本），可包含 `visible.jsonl`、`hidden.jsonl` 等测试数据文件。`submission.py` 由评测系统自动注入，不应放入支持包。

#### Scenario: 支持包结构文档可访问

- **WHEN** 用户在题目编辑器中准备上传支持包
- **THEN** UI 显示文件结构引导，说明必需文件和推荐的文件组织方式
