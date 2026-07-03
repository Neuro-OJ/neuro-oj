## MODIFIED Requirements

### Requirement: 支持包上传

系统 SHALL 提供 `POST /api/v1/problems/:id/support-package` 端点，接受 multipart/form-data 格式的 zip 文件上传，通过 StorageProvider 存储 zip 数据并更新数据库中 `support_package_path` 字段。

存储路径格式取决于当前 `STORAGE_PROVIDER`：
- `STORAGE_PROVIDER=local`：`put()` 返回 `storage://local/<base64>`（zip 数据编码到 URL 中）
- `STORAGE_PROVIDER=s3`：`put()` 返回 `storage://s3/packages/<problem_id>.zip`（数据存入 S3，DB 统一用 `storage://` URL）

上传者 MUST 是题目所有者或管理员，否则返回 HTTP 403。

上传文件大小 MUST 不超过 128 MiB。

#### Scenario: 所有者上传支持包（local 模式）

- **WHEN** `STORAGE_PROVIDER=local`
- **WHEN** 题目所有者发送 `POST /api/v1/problems/:id/support-package`，携带有效的 `.zip` 文件
- **THEN** 系统通过 `LocalStorageProvider.put()` 将 zip 编码为 base64，更新 `support_package_path` 为 `"storage://local/<base64>"`，返回 HTTP 200

#### Scenario: 所有者上传支持包（S3 模式）

- **WHEN** `STORAGE_PROVIDER=s3`
- **WHEN** 题目所有者发送 `POST /api/v1/problems/:id/support-package`，携带有效的 `.zip` 文件
- **THEN** 系统通过 `S3StorageProvider.put()` 将 zip 存入 S3 配置的 bucket
- **THEN** 更新 `support_package_path` 为 `"storage://s3/packages/<problem_id>.zip"`，返回 HTTP 200

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
- **THEN** 系统通过 StorageProvider 覆盖（local 模式重新编码 base64；S3 模式 PutObject 覆盖 object），返回 HTTP 200

### Requirement: 支持包删除

系统 SHALL 提供 `DELETE /api/v1/problems/:id/support-package` 端点，通过 StorageProvider 删除已上传的支持包文件并将数据库中的 `support_package_path` 设为 `null`。

删除者 MUST 是题目所有者或管理员。

#### Scenario: 题目所有者成功删除支持包（local 模式）

- **WHEN** `STORAGE_PROVIDER=local`，支持包路径为 `storage://local/<base64>`
- **WHEN** 题目所有者发送 `DELETE /api/v1/problems/:id/support-package`
- **THEN** 系统将 `support_package_path` 设为 `null`，返回 HTTP 200（本地不涉及文件系统操作）

#### Scenario: 题目所有者成功删除支持包（S3 模式）

- **WHEN** `STORAGE_PROVIDER=s3`，支持包路径为 `storage://s3/packages/<problem_id>.zip`
- **WHEN** 题目所有者发送 `DELETE /api/v1/problems/:id/support-package`
- **THEN** 系统调用 `S3StorageProvider.delete("storage://s3/packages/<problem_id>.zip")` 删除 S3 对象，将 `support_package_path` 设为 `null`，返回 HTTP 200

#### Scenario: 删除不存在的支持包

- **WHEN** 题目尚无支持包，所有者发送 `DELETE /api/v1/problems/:id/support-package`
- **THEN** 系统返回 HTTP 200（幂等操作，数据库字段已为 null）

#### Scenario: 非所有者删除被拒

- **WHEN** 非所有者、非管理员的用户发送 `DELETE /api/v1/problems/:id/support-package`
- **THEN** 系统返回 HTTP 403

## ADDED Requirements

### Requirement: 支持包下载

系统 SHALL 提供 `GET /api/v1/problems/:id/support-package` 端点，允许题目所有者和管理员下载已上传的支持包 zip 文件。

处理方式取决于存储后端：
- S3 模式：通过 `presignedUrl()` 生成限时 S3 URL → HTTP 302 重定向
- Local 模式：通过 `get()` 解码 base64 → 直接返回文件内容

下载者 MUST 是题目所有者或管理员，否则返回 HTTP 403。

#### Scenario: 所有者下载支持包（S3 模式）

- **WHEN** `STORAGE_PROVIDER=s3`，支持包路径为 `storage://s3/packages/<problem_id>.zip`
- **WHEN** 题目所有者发送 `GET /api/v1/problems/:id/support-package`
- **THEN** 系统调用 `S3StorageProvider.presignedUrl("storage://s3/packages/<problem_id>.zip")` 生成 presigned HTTPS URL
- **THEN** 返回 HTTP 302 重定向到该 URL

#### Scenario: 所有者下载支持包（local 模式）

- **WHEN** `STORAGE_PROVIDER=local`，支持包路径为 `storage://local/<base64>`
- **WHEN** 题目所有者发送 `GET /api/v1/problems/:id/support-package`
- **THEN** 系统调用 `LocalStorageProvider.get()` 解码 base64 返回原始 zip
- **THEN** 返回 HTTP 200，`Content-Type: application/zip`，`Content-Disposition: attachment`

#### Scenario: 无支持包时下载

- **WHEN** 用户请求下载尚无支持包的题目
- **THEN** 系统返回 HTTP 404

#### Scenario: 非所有者下载被拒

- **WHEN** 非所有者、非管理员的用户发送 `GET /api/v1/problems/:id/support-package`
- **THEN** 系统返回 HTTP 403
