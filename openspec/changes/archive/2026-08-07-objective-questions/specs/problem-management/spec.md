## MODIFIED Requirements

### Requirement: 用户可创建题目

系统 SHALL 提供 `POST /api/v1/problems`，管理员可创建任意 type 的题目，
普通用户可创建 type='U'（用户题）与 type='O'（客观题套卷）的题目（自动成为所有者）。

创建 O 型套卷 SHALL 不要求 `runtime_config`（客观题无评测容器）；创建 U/P 型 SHALL 继续要求 `runtime_config`。

#### Scenario: 管理员成功创建 P 型题目
- **WHEN** 管理员发送 `POST /api/v1/problems` 并携带 type='P' 及有效字段
- **THEN** 系统创建 P 型题目并返回 201

#### Scenario: 普通用户成功创建 U 型题目
- **WHEN** 普通用户发送 `POST /api/v1/problems` 并携带 type='U' 及有效字段
- **THEN** 系统创建 U 型题目，自动设 owner_id 为当前用户，自动分配 number，返回 201

#### Scenario: 普通用户成功创建 O 型套卷
- **WHEN** 普通用户发送 `POST /api/v1/problems` 并携带 type='O'、title、description 且不含 runtime_config
- **THEN** 系统创建 O 型套卷，自动设 owner_id 为当前用户，自动分配 number，返回 201

#### Scenario: 普通用户尝试创建 P 型题目
- **WHEN** 普通用户调用 `POST /api/v1/problems` 并携带 type='P'
- **THEN** 系统返回 HTTP 403

#### Scenario: 创建题目时不传 type 默认 U
- **WHEN** 用户发送 `POST /api/v1/problems` 且未传 type 字段
- **THEN** 系统默认 type='U'

#### Scenario: 缺少必填字段
- **WHEN** 用户创建题目时缺少 `title`、`judge_image` 或 `judge_command`
- **THEN** 系统返回 HTTP 400，提示缺少必填字段

#### Scenario: 非法难度值
- **WHEN** 用户创建题目时传入 `difficulty: "expert"`
- **THEN** 系统返回 HTTP 400，提示难度值仅允许 easy/medium/hard
