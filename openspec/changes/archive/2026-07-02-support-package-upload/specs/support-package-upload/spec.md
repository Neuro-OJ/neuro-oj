## ADDED Requirements

### Requirement: 支持包上传

系统 SHALL 提供 `POST /api/v1/problems/:id/support-package` 端点，接受 multipart/form-data 格式的 zip 文件上传，将文件存储至 `data/packages/<problem_id>.zip` 并更新数据库中 `support_package_path` 字段。

上传者 MUST 是题目所有者或管理员，否则返回 HTTP 403。

#### Scenario: 题目所有者成功上传支持包

- **WHEN** 题目所有者发送 `POST /api/v1/problems/:id/support-package`，携带有效的 `.zip` 文件（`Content-Type: multipart/form-data`，文件字段名为 `file`）
- **THEN** 系统将 zip 保存至 `data/packages/<problem_id>.zip`，更新 `support_package_path` 为 `"data/packages/<problem_id>.zip"`，返回 HTTP 200 及 `{ data: { support_package_path: "data/packages/<problem_id>.zip" } }`

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

- **WHEN** 题目已有支持包，所有者在 `POST /api/v1/problems/:id/support-package` 上传新文件
- **THEN** 系统覆盖旧文件，更新数据库路径（路径不变，文件内容变更），返回 HTTP 200

### Requirement: 支持包删除

系统 SHALL 提供 `DELETE /api/v1/problems/:id/support-package` 端点，删除已上传的支持包文件并将数据库中的 `support_package_path` 设为 `null`。

删除者 MUST 是题目所有者或管理员。

#### Scenario: 题目所有者成功删除支持包

- **WHEN** 题目所有者发送 `DELETE /api/v1/problems/:id/support-package`
- **THEN** 系统删除 `data/packages/<problem_id>.zip` 文件（若存在），将 `support_package_path` 设为 `null`，返回 HTTP 200

#### Scenario: 删除不存在的支持包

- **WHEN** 题目尚无支持包，所有者发送 `DELETE /api/v1/problems/:id/support-package`
- **THEN** 系统返回 HTTP 200（幂等操作，无文件需删除，数据库字段已为 null）

#### Scenario: 非所有者删除被拒

- **WHEN** 非所有者、非管理员的用户发送 `DELETE /api/v1/problems/:id/support-package`
- **THEN** 系统返回 HTTP 403

### Requirement: 支持包上传状态在题目详情中可见

系统 SHALL 在 `GET /api/v1/problems/:id` 响应中包含 `support_package_path` 字段和派生的 `has_support_package` 布尔字段，表示题目当前是否有已上传的支持包。

#### Scenario: 获取有支持包的题目详情

- **WHEN** 用户请求 `GET /api/v1/problems/:id`，题目已设置 `support_package_path`
- **THEN** 响应中 `data.support_package_path` 为非 null 字符串，`data.has_support_package` 为 `true`

#### Scenario: 获取无支持包的题目详情

- **WHEN** 用户请求 `GET /api/v1/problems/:id`，题目 `support_package_path` 为 null
- **THEN** 响应中 `data.support_package_path` 为 null，`data.has_support_package` 为 `false`

### Requirement: 支持包文件结构规范

系统 SHALL 要求上传的支持包 zip 文件遵循以下结构：所有文件直接位于 zip 根层级，不包含顶级文件夹。

zip 内 MUST 包含 `evaluate.py`（评测脚本），可包含 `visible.jsonl`、`hidden.jsonl` 等测试数据文件。`submission.py` 由评测系统自动注入，不应放入支持包。

#### Scenario: 支持包结构文档可访问

- **WHEN** 用户在题目编辑器中准备上传支持包
- **THEN** UI 显示文件结构引导，说明必需文件和推荐的文件组织方式
