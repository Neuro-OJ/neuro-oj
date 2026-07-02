私信系统后端 API。覆盖会话 CRUD、消息收发、已读追踪、未读计数、消息删除和 SSE 实时推送。

## 需求

### Requirement: 会话创建与查找
系统 SHALL 允许用户根据对方用户 ID 创建或查找会话。

#### Scenario: 新会话创建
- **WHEN** 用户 A 发送请求 POST /api/v1/conversations 并指定对方用户 B 的 ID
- **THEN** 系统创建新会话并返回会话 ID，状态码 201

#### Scenario: 已有会话查找
- **WHEN** 用户 A 请求 POST /api/v1/conversations 且与用户 B 已有会话
- **THEN** 系统返回已有会话信息，状态码 200（非 201）

#### Scenario: 拒绝自聊
- **WHEN** 用户 A 请求创建与自己（A）的会话
- **THEN** 系统返回 400 BadRequestError

#### Scenario: 对方用户不存在
- **WHEN** 用户 A 请求创建与不存在用户 ID 的会话
- **THEN** 系统返回 404 NotFoundError

### Requirement: 会话列表
系统 SHALL 允许用户获取其参与的所有会话列表，带分页和未读计数。

#### Scenario: 成功获取会话列表
- **WHEN** 已登录用户请求 GET /api/v1/conversations
- **THEN** 系统返回分页的会话列表，每个会话包含：对方用户名、最后消息预览、最后消息时间、未读消息数
- **THEN** 列表按 last_message_at DESC 排序

#### Scenario: 空会话列表
- **WHEN** 用户没有参与任何会话时请求列表
- **THEN** 系统返回 data: [] 的空列表

#### Scenario: 已注销用户的会话
- **WHEN** 会话的对方用户已被删除
- **THEN** 列表中对方用户名显示为"已注销用户"

### Requirement: 消息发送
系统 SHALL 允许会话参与者发送文本消息。

#### Scenario: 成功发送消息
- **WHEN** 用户 A 请求 POST /api/v1/conversations/:id/messages 并包含 content（1-10000 字符）
- **THEN** 系统创建消息记录，更新会话的 last_message_at，状态码 201
- **THEN** 系统通过 Redis Pub/Sub 发送消息通知到 noj:events:user:<接收者 ID>

#### Scenario: 非参与者禁止发送
- **WHEN** 用户 C（非会话参与者）请求向会话发消息
- **THEN** 系统返回 404 NotFoundError

#### Scenario: 空内容消息
- **WHEN** 用户发送空字符串 content
- **THEN** 系统返回 400 BadRequestError

#### Scenario: 超长消息
- **WHEN** 用户发送超过 10000 字符的消息
- **THEN** 系统返回 400 BadRequestError

### Requirement: 消息列表
系统 SHALL 允许会话参与者分页获取消息历史。

#### Scenario: 成功获取消息
- **WHEN** 会话参与者请求 GET /api/v1/conversations/:id/messages
- **THEN** 系统返回分页消息列表，按 created_at DESC 排序（page=1 为最新页）

#### Scenario: 消息已删除用户不可见
- **WHEN** 用户删除某消息后请求消息列表
- **THEN** 该消息不在返回列表中

#### Scenario: 非参与者禁止查看
- **WHEN** 非参与者请求会话消息列表
- **THEN** 系统返回 404 NotFoundError

### Requirement: 已读标记
系统 SHALL 允许用户标记会话为已读至指定消息位置。

#### Scenario: 成功标记已读
- **WHEN** 用户请求 POST /api/v1/conversations/:id/read 并指定 last_read_message_id
- **THEN** 系统更新或创建 conversation_reads 记录，状态码 200

#### Scenario: 多次标记已读（覆盖）
- **WHEN** 用户再次标记已读且指定更新的消息 ID
- **THEN** 系统更新现有记录，不创建重复

### Requirement: 未读计数
系统 SHALL 返回用户的未读消息总数。

#### Scenario: 获取总未读数
- **WHEN** 用户请求 GET /api/v1/conversations/unread-count
- **THEN** 系统返回 { unread_count: <number> }

#### Scenario: 全部已读后为零
- **WHEN** 用户已阅读所有消息后请求
- **THEN** 系统返回 unread_count: 0

### Requirement: 消息删除
系统 SHALL 允许用户从自己的视角删除消息。

#### Scenario: 成功删除消息（自己视角）
- **WHEN** 用户请求 DELETE /api/v1/conversations/:id/messages/:msgId
- **THEN** 系统在 message_deletions 表插入记录（不删除原始消息），状态码 204

#### Scenario: 删除后列表不可见
- **WHEN** 用户删除消息后再次获取消息列表
- **THEN** 该消息不在返回中
- **AND** 对方仍能看到该消息

### Requirement: SSE 实时推送
系统 SHALL 通过 SSE 向登录用户实时推送新消息通知。

#### Scenario: 连接 SSE
- **WHEN** 已登录用户连接到 GET /api/v1/conversations/events
- **THEN** 系统建立 SSE 流并保持连接

#### Scenario: 收到新消息通知
- **WHEN** 用户 B 的 SSE 连接活跃期间，用户 A 向 B 发送消息
- **THEN** B 的 SSE 流收到事件 event: message:new，data 包含 conversation_id 和 sender_id

#### Scenario: 30 秒心跳
- **WHEN** SSE 连接已建立
- **THEN** 系统每 30 秒发送 event: keepalive 事件，保持连接不超时

#### Scenario: 客户端断开清理
- **WHEN** 客户端断开 SSE 连接
- **THEN** 系统清理事件监听器和定时器，不泄漏资源
