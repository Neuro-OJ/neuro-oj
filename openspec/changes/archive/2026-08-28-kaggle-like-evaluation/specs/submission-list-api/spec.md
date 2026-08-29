## ADDED Requirements

### Requirement: 创建 artifact 提交

系统 SHALL 允许 artifact 题目通过 `POST /api/v1/submissions` 以 multipart/form-data 上传 zip 文件。请求包含 `problem_id`、`language`、`file`（zip）。

服务端 SHALL 校验：
- 题目必须是 `submission_mode=artifact`
- 必须上传 zip 文件
- zip 大小不得超过 2GB
- zip 安全校验复用现有支持包校验

提交记录 SHALL 存储 `artifact_storage_url`，`file_name` 存 zip 文件名，`code` 为空字符串。

#### Scenario: 成功创建 artifact 提交

- **WHEN** 已登录用户向 artifact 题目上传合法 zip
- **THEN** 系统创建提交记录，返回 201，`file_name` 为 zip 文件名

#### Scenario: 向 code 题目上传 zip 被拒

- **WHEN** 用户向 `submission_mode=code` 的题目上传 zip
- **THEN** 系统返回 HTTP 400，提示该题目不支持 artifact 提交

#### Scenario: artifact 题目缺少 zip 被拒

- **WHEN** 用户向 artifact 题目提交 JSON body（无 file）
- **THEN** 系统返回 HTTP 400，提示必须上传 zip 文件

### Requirement: 提交列表与详情返回分数

系统 SHALL 在提交列表和详情接口中，以 `result.score` 作为评测结果，`result.status` 只使用 `finished` 或 `error`，不再返回 `Accepted` / `WrongAnswer`。

#### Scenario: 列表返回分数

- **WHEN** 用户 GET `/api/v1/submissions` 且某提交已完成
- **THEN** 该提交的 `result.status` 为 `finished`，`result.score` 为对应分数

#### Scenario: 详情返回分数

- **WHEN** 用户 GET `/api/v1/submissions/:id` 且提交已完成
- **THEN** 响应包含 `result.status: "finished"` 和 `result.score`
