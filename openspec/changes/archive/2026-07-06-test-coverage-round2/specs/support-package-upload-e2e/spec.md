## ADDED Requirements

### Requirement: 支持包 S3 上传 E2E

测试 SHALL 验证 `STORAGE_PROVIDER=s3` 模式下支持包上传、下载和删除功能。

#### Scenario: 所有者上传支持包（S3 模式）

- **WHEN** 环境变量 `S3_ENDPOINT` 已设置（MinIO 可用）
- **WHEN** `STORAGE_PROVIDER=s3`
- **WHEN** 题目所有者发送 `POST /api/v1/problems/:id/support-package` 携带合法 `.zip` 文件
- **THEN** 返回 HTTP 200
- **THEN** `data.support_package_storage_url` 以 `noj-storage://s3/` 开头
- **THEN** `data.support_package_storage_url` 包含 `checksum_sha256=`

#### Scenario: 管理员为他人题目上传

- **WHEN** admin 为其他用户的题目上传支持包
- **THEN** 返回 HTTP 200
- **THEN** `has_support_package` 为 true

#### Scenario: 非所有者上传被拒

- **WHEN** 非所有者、非 admin 用户上传支持包
- **THEN** 返回 HTTP 403

#### Scenario: 上传非 zip 文件被拒

- **WHEN** 上传非 `.zip` 文件
- **THEN** 返回 HTTP 400

### Requirement: 支持包 S3 下载 E2E

测试 SHALL 验证 S3 模式下支持包下载通过 noj-core 代理。

#### Scenario: 所有者下载支持包

- **WHEN** 题目已上传 S3 支持包
- **WHEN** 所有者调用 `GET /api/v1/problems/:id/support-package`
- **THEN** 返回 HTTP 200
- **THEN** `Content-Type` 为 `application/zip`

#### Scenario: 无支持包时下载

- **WHEN** 题目尚无支持包
- **WHEN** 所有者调用 `GET /api/v1/problems/:id/support-package`
- **THEN** 返回 HTTP 404

### Requirement: 支持包 S3 删除 E2E

#### Scenario: 删除 S3 支持包

- **WHEN** 题目已有 S3 支持包
- **WHEN** 所有者调用 `DELETE /api/v1/problems/:id/support-package`
- **THEN** 返回 HTTP 200
- **THEN** `GET /api/v1/problems/:id` 中 `has_support_package` 为 false

#### Scenario: 非所有者删除被拒

- **WHEN** 非所有者、非 admin 用户调用删除
- **THEN** 返回 HTTP 403
