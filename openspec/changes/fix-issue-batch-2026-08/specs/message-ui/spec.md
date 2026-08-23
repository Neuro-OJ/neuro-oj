## ADDED Requirements

### Requirement: 发送后即时刷新会话列表

系统 SHALL 在用户发送消息成功后立即刷新左侧会话列表，无需手动刷新页面。

#### Scenario: 发送消息后侧栏更新

- **WHEN** 用户在聊天页发送一条消息并成功返回
- **THEN** 左侧会话列表立即刷新，最新消息预览与会话排序更新

### Requirement: 打开或活跃会话后清除未读

系统 SHALL 在用户打开会话、或当前活跃会话收到新消息时，自动标记已读并刷新未读红点。

#### Scenario: 打开会话清除未读

- **WHEN** 用户点击进入一个存在未读消息的会话
- **THEN** 系统标记该会话已读，左侧会话列表的未读红点立即消失

#### Scenario: 活跃会话收到新消息后自动已读

- **WHEN** 用户正在查看某个会话且该会话收到对方新消息
- **THEN** 消息列表加载新消息后自动标记已读，未读红点不堆积

### Requirement: 私信关闭时停止轮询并一次性提示

系统 SHALL 在私信功能关闭时停止会话列表的 SSE 与 fallback 轮询，并只提示一次“站内私信功能已关闭”。

#### Scenario: 收到 feature:disabled 后停止轮询

- **WHEN** 私信 SSE 收到 `feature:disabled` 事件
- **THEN** 前端关闭 EventSource、停止 fallback 轮询，并显示一次性提示

#### Scenario: 关闭后不再重复弹错误

- **WHEN** 私信功能关闭且用户停留在消息页
- **THEN** 页面不再每隔数秒弹出“站内私信功能已关闭”错误