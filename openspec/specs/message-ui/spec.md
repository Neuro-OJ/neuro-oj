私信系统前端界面。覆盖会话列表页、聊天详情页、导航栏未读徽标和用户主页入口。

## Requirements

### Requirement: 私信 Composable
系统 SHALL 提供 Vue composable 封装私信功能的 API 调用和状态管理。

#### Scenario: 封装 API 调用
- **WHEN** 前端组件调用 useMessages()
- **THEN** 获取 API 封装函数：{ fetchConversations, fetchMessages, sendMessage, markRead, fetchUnreadCount }

#### Scenario: 不可用于导航栏
- **WHEN** 用户停留在非私信页面（如首页、题库）
- **THEN** composable 不建立任何 SSE 连接
- **THEN** 导航栏未读数仅通过定时轮询 fetchUnreadCount 获取

### Requirement: 会话列表页
系统 SHALL 在 /messages 路径提供会话列表页面，需要登录。

#### Scenario: 加载会话列表
- **WHEN** 已登录用户访问 /messages
- **THEN** 显示用户的所有会话列表

#### Scenario: 会话项信息
- **WHEN** 会话列表已加载
- **THEN** 每个会话项显示：对方用户名、最后消息预览（截断 50 字）、时间、未读消息数徽标

#### Scenario: 空状态
- **WHEN** 用户没有任何会话
- **THEN** 页面显示"暂无会话"

#### Scenario: 点击进入聊天
- **WHEN** 用户点击某个会话项
- **THEN** 跳转到 /messages/:id 聊天详情页

#### Scenario: SSE 实时刷新
- **WHEN** 用户在会话列表页并建立了 SSE 连接
- **THEN** 收到 message:new 事件时自动刷新会话列表

#### Scenario: SSE 降级轮询
- **WHEN** SSE 不可用或连接断开
- **THEN** 页面自动降级到 3 秒间隔轮询 fetchConversations

#### Scenario: 未登录重定向
- **WHEN** 未登录用户访问 /messages
- **THEN** 重定向到 /login

### Requirement: 聊天详情页
系统 SHALL 在 /messages/:id 路径提供单会话聊天界面，需要登录。

#### Scenario: 显示消息历史
- **WHEN** 用户进入聊天页面
- **THEN** 显示该会话的消息列表，最新消息在底部，最旧消息在上方

#### Scenario: 消息气泡
- **WHEN** 消息列表已加载
- **THEN** 自己发送的消息右对齐（蓝色/主题色气泡背景），对方消息左对齐（灰色气泡背景）
- **THEN** 每条消息显示发送时间和内容

#### Scenario: 发送消息
- **WHEN** 用户在输入框键入内容并按发送按钮或回车
- **THEN** 调用 POST /api/v1/conversations/:id/messages
- **THEN** 新消息追加到底部，输入框清空

#### Scenario: 空输入不可发送
- **WHEN** 输入框为空或仅含空白字符
- **THEN** 发送按钮处于禁用状态

#### Scenario: 自动标记已读
- **WHEN** 用户打开聊天页面
- **THEN** 自动调用 POST /api/v1/conversations/:id/read 标记最新消息为已读

#### Scenario: 加载更多历史消息
- **WHEN** 用户滚动到消息列表顶部
- **THEN** 加载更早的消息页并追加到列表上方

#### Scenario: 实时接收新消息
- **WHEN** 用户在聊天页面中，对方发送新消息
- **THEN** 新消息自动出现（通过轮询或 SSE）

### Requirement: 导航栏未读徽标
系统 SHALL 在导航栏显示私信图标和未读消息总数。

#### Scenario: 显示私信图标
- **WHEN** 用户已登录
- **THEN** 导航栏显示私信图标（Mail 或 MessageSquare Lucide 图标）

#### Scenario: 未读徽标
- **WHEN** 用户有未读消息
- **THEN** 图标右上角显示红色圆形徽标，内容为未读数（最多显示 99+）

#### Scenario: 定时轮询更新
- **WHEN** 用户已登录且在任意页面
- **THEN** 导航栏每 30 秒调用 GET /api/v1/conversations/unread-count 刷新未读数
- **THEN** 不建立 SSE 连接，避免跨页面生命周期管理

#### Scenario: 点击跳转
- **WHEN** 用户点击私信图标
- **THEN** 跳转到 /messages 页面

### Requirement: 用户主页入口
系统 SHALL 在用户主页提供"发送私信"按钮。

#### Scenario: 显示发送私信按钮
- **WHEN** 当前登录用户访问其他用户的个人主页
- **THEN** 用户信息旁显示"发送私信"按钮

#### Scenario: 点击跳转到聊天
- **WHEN** 用户点击"发送私信"按钮
- **THEN** 创建或查找与该用户的会话，然后跳转到 /messages/:id 页面
