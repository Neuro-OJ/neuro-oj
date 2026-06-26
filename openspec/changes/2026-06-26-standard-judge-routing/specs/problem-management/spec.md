## Purpose

题目管理规范增量更新：API 接收/返回 `judge_type` 字段，列表筛选支持 `judge_type`，
JudgeTask 消息透传 `judge_type` 给 noj-judge。

## MODIFIED Requirements

### Requirement: 创建题目支持 judge_type

系统 SHALL 在 `POST /api/v1/problems` 请求体接受可选的 `judge_type` 字段，
合法值为 `'standard'` 或 `'special'`，默认 `'special'`。

#### Scenario: 不传 judge_type 创建题目

- **WHEN** 客户端 `POST /api/v1/problems` 且未传 `judge_type`
- **THEN** 数据库默认设置 `judge_type='special'`，响应中返回 `judge_type: "special"`

#### Scenario: 显式传 standard 创建题目

- **WHEN** 客户端 `POST /api/v1/problems` 携带 `judge_type: "standard"`
- **THEN** 数据库存储该值，响应中返回 `judge_type: "standard"`

#### Scenario: 非法 judge_type 被拒

- **WHEN** 客户端 `POST /api/v1/problems` 携带 `judge_type: "invalid"`
- **THEN** 系统返回 HTTP 400，错误信息列出合法值

### Requirement: 更新题目支持 judge_type

系统 SHALL 在 `PUT /api/v1/problems/:id` 请求体接受可选的 `judge_type` 字段，
允许 admin 修改评测类型。

#### Scenario: 修改 judge_type

- **WHEN** 管理员 `PUT /api/v1/problems/:id` 携带 `judge_type: "standard"`
- **THEN** 数据库更新该字段，响应中返回最新值

#### Scenario: 部分更新不影响 judge_type

- **WHEN** 客户端仅 `PUT` `title` 字段，未传 `judge_type`
- **THEN** `judge_type` 保持原值不变

### Requirement: 题目列表支持 judge_type 筛选

系统 SHALL 在 `GET /api/v1/problems` 支持 `judge_type` 查询参数。

#### Scenario: 按 judge_type 筛选

- **WHEN** 用户请求 `GET /api/v1/problems?judge_type=standard`
- **THEN** 系统仅返回 `judge_type='standard'` 的题目

#### Scenario: 不传 judge_type 不影响筛选

- **WHEN** 用户请求 `GET /api/v1/problems` 不带 `judge_type`
- **THEN** 系统返回所有题目（不应用 judge_type 过滤）

### Requirement: 题目响应包含 judge_type

系统 SHALL 在题目列表、详情 API 响应中包含 `judge_type` 字段。

#### Scenario: 列表响应

- **WHEN** 客户端请求 `GET /api/v1/problems`
- **THEN** 响应中每个题目对象包含 `judge_type: "standard"` 或 `"special"`

#### Scenario: 详情响应

- **WHEN** 客户端请求 `GET /api/v1/problems/:id`
- **THEN** 响应 `data` 对象包含 `judge_type` 字段

### Requirement: 评测任务消息透传 judge_type

系统 SHALL 在推送到 Redis MQ 的 `JudgeTask` 消息中包含 `judge_type` 字段，
取自 problem 记录。

#### Scenario: 创建提交时构造 JudgeTask

- **WHEN** 用户提交代码且 problem 的 `judge_type='standard'`
- **THEN** 推送到 `noj:judge:queue` 的 JudgeTask JSON 包含 `"judge_type": "standard"`

#### Scenario: problem judge_type=special

- **WHEN** 用户提交代码且 problem 的 `judge_type='special'`
- **THEN** 推送的 JudgeTask 包含 `"judge_type": "special"`

### Requirement: JudgeTask 字段向后兼容

noj-judge SHALL 在 JudgeTask 消息缺失 `judge_type` 字段时默认为 `special`，
确保旧 noj-core 实例推送的消息能正常处理。

#### Scenario: 旧格式消息（无 judge_type）

- **WHEN** noj-judge 从 MQ 拉取不含 `judge_type` 字段的 JudgeTask（来自未升级的 noj-core）
- **THEN** serde 反序列化使用默认值 `Special`，走现有 Python evaluate.py 路径