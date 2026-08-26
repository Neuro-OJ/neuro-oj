## ADDED Requirements

### Requirement: 题目支持 submission_mode

系统 SHALL 在 `problems` 表提供 `submission_mode` 字段，取值 `code`（默认）或 `artifact`。题目创建/更新接口 SHALL 接受该字段，并在响应中返回。

`submission_mode=artifact` 的题目 SHALL 仍要求 `runtime_config`（双容器评测），且不要求 `code` 提交。

#### Scenario: 创建 artifact 题目

- **WHEN** 管理员创建题目时设置 `submission_mode: "artifact"` 且提供 `runtime_config`
- **THEN** 系统创建成功，响应包含 `submission_mode: "artifact"`

#### Scenario: 默认 submission_mode 为 code

- **WHEN** 用户创建题目且未传 `submission_mode`
- **THEN** 系统默认 `submission_mode: "code"`

#### Scenario: 更新题目 submission_mode

- **WHEN** 管理员更新题目时设置 `submission_mode: "artifact"`
- **THEN** 系统更新成功，响应包含新的 `submission_mode`

#### Scenario: 非法 submission_mode 被拒

- **WHEN** 用户创建或更新题目时传入 `submission_mode: "prediction"`
- **THEN** 系统返回 HTTP 400，提示仅允许 `code` / `artifact`
