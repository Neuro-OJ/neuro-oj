## ADDED Requirements

### Requirement: 私信会话创建 E2E

测试 SHALL 验证两个用户之间的会话创建流程。

#### Scenario: 用户间创建新会话

- **WHEN** 用户 A 注册并登录
- **WHEN** 用户 B 注册并登录
- **WHEN** 用户 A 调用 `POST /api/v1/conversations` 指定用户 B 的 ID
- **THEN** 返回 HTTP 201
- **THEN** 响应体中包含 `data.id`（会话 ID）

#### Scenario: 已存在会话返回 200

- **WHEN** 用户 A 再次调用 `POST /api/v1/conversations` 指定用户 B 的 ID
- **THEN** 返回 HTTP 200
- **THEN** 响应中包含相同的会话 `data.id`

#### Scenario: 拒绝自聊

- **WHEN** 用户 A 调用 `POST /api/v1/conversations` 指定自己的 ID
- **THEN** 返回 HTTP 400

#### Scenario: 目标用户不存在

- **WHEN** 用户 A 调用 `POST /api/v1/conversations` 指定不存在的用户 ID
- **THEN** 返回 HTTP 404

### Requirement: 消息发送与已读 E2E

测试 SHALL 验证消息发送、列表、已读标记和已读计数。

#### Scenario: 用户 A 向 B 发送消息

- **WHEN** 用户 A 调用 `POST /api/v1/conversations/:id/messages` 包含 `{ "content": "Hello" }`
- **THEN** 返回 HTTP 201
- **THEN** 响应 `data.content` 等于 "Hello"

#### Scenario: 空内容被拒

- **WHEN** 用户 A 发送空 `content: ""`
- **THEN** 返回 HTTP 400

#### Scenario: 消息列表分页

- **WHEN** 用户 A 调用 `GET /api/v1/conversations/:id/messages`
- **THEN** 返回 HTTP 200
- **THEN** `data` 为消息数组，包含刚发送的消息

#### Scenario: 已读标记

- **WHEN** 用户 B 调用 `POST /api/v1/conversations/:id/read` 指定 `last_read_message_id`
- **THEN** 返回 HTTP 200

#### Scenario: 未读计数

- **WHEN** 用户 B 调用 `GET /api/v1/conversations/unread-count`
- **THEN** 返回 HTTP 200
- **THEN** `data.unread_count` 为非负整数

### Requirement: 消息删除 E2E

测试 SHALL 验证消息按视角删除。

#### Scenario: 发送方删除消息（自己的视角）

- **WHEN** 用户 A 调用 `DELETE /api/v1/conversations/:id/messages/:msgId`
- **THEN** 返回 HTTP 204

#### Scenario: 删除后发送方列表不可见

- **WHEN** 用户 A 再次获取消息列表
- **THEN** 已删除消息不在返回列表中
- **WHEN** 用户 B 获取消息列表
- **THEN** 该消息仍然可见（对方视角不受影响）

### Requirement: 非参与者权限验证 E2E

#### Scenario: 非参与者发送消息被拒

- **WHEN** 用户 C（非参与者）调用 `POST /api/v1/conversations/:id/messages`
- **THEN** 返回 HTTP 404

#### Scenario: 非参与者查看消息被拒

- **WHEN** 用户 C 调用 `GET /api/v1/conversations/:id/messages`
- **THEN** 返回 HTTP 404

### Requirement: 私信 SSE 实时推送 E2E

#### Scenario: 私信 SSE 连接与推送

- **WHEN** 用户 B 连接 `GET /api/v1/conversations/events`
- **WHEN** 用户 A 向 B 发送消息
- **THEN** B 的 SSE 流在 15 秒内收到 `event: message:new` 事件
- **THEN** data 包含 `conversation_id` 和 `sender_id`
