## MODIFIED Requirements

### Requirement: 未读计数

系统 SHALL 返回用户的未读消息总数；未读计数 MUST 排除“当前用户自己发送的消息”，仅统计他人发送且尚未阅读的消息。

#### Scenario: 获取总未读数

- **WHEN** 用户请求 GET /api/v1/conversations/unread-count
- **THEN** 系统返回 { unread_count: <number> }

#### Scenario: 全部已读后为零

- **WHEN** 用户已阅读所有消息后请求
- **THEN** 系统返回 unread_count: 0

#### Scenario: 自己发送的消息不产生未读

- **WHEN** 用户 A 在会话中发送一条消息后刷新会话列表或未读计数
- **THEN** 该消息不计入 A 自己的未读数，A 的 unread_count 不因自己的消息增加

#### Scenario: 对方发送的消息计入未读

- **WHEN** 用户 B 向用户 A 发送新消息且 A 尚未阅读
- **THEN** A 的未读计数包含该消息

### Requirement: 私信功能动态开关

管理员 SHALL 能动态关闭私信功能。关闭后普通私信 API MUST 返回 `FEATURE_DISABLED` 403；私信 SSE 端点 MUST 发送一次 `feature:disabled` 事件后关闭连接，而不是持续向客户端返回错误。前端隐藏入口，已有会话和消息 MUST 保留。

#### Scenario: 重新开启私信

- **WHEN** 管理员关闭后重新开启私信
- **THEN** 用户可继续读取原会话和发送消息

#### Scenario: SSE 端点收到关闭事件

- **WHEN** 私信功能关闭且用户已连接 `GET /api/v1/conversations/events`
- **THEN** SSE 流发送 `event: feature:disabled` 后关闭连接

#### Scenario: 私信关闭后普通 API 返回 403

- **WHEN** 私信功能关闭且用户请求会话列表、消息列表或发送消息
- **THEN** 系统返回 403，错误码为 `FEATURE_DISABLED`