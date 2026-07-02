## 1. 数据库与基础设施

- [x] 1.1 在 `noj-core/src/db/schema.ts` 追加 conversations、messages、conversation_reads、message_deletions 四张表定义
- [x] 1.2 运行 `deno task db:generate` 生成迁移 SQL 文件
- [x] 1.3 在 `noj-core/src/lib/event-bus.ts` 的 Channels 中添加 user(id) 方法

## 2. 后端服务层

- [x] 2.1 新建 `noj-core/src/services/messages.ts` — 实现 findOrCreateConversation 函数（拒绝自聊、并发安全）
- [x] 2.2 实现 sendMessage 函数（校验参与者、写消息、更新 last_message_at、发布 Redis 事件）
- [x] 2.3 实现 listConversations 函数（分页、未读计数、已注销用户处理）
- [x] 2.4 实现 listMessages 函数（分页、排除已删除消息）
- [x] 2.5 实现 markConversationRead、getUnreadCount、getUnreadCountByConversation 函数
- [x] 2.6 实现 deleteMessage 函数（软删除）

## 3. 后端路由与 SSE

- [x] 3.1 新建 `noj-core/src/routes/messages.ts` — 实现全部 REST 端点（conversations CRUD、messages CRUD、unread-count）
- [x] 3.2 在 `noj-core/src/routes/sse.ts` 追加 GET /conversations/events SSE 端点
- [x] 3.3 在 `noj-core/src/app.ts` 注册 messages 路由

## 4. 后端测试

- [x] 4.1 编写服务层单元测试（创建会话、发消息、列表、已读、删除、拒绝自聊/非参与者）
- [x] 4.2 编写路由层测试（24 个用例覆盖所有端点 + 认证要求验证）
- [x] 4.3 运行 `deno task test` 确认全部通过

## 5. 前端 Composable

- [x] 5.1 新建 `noj-ui/composables/useMessages.ts` — 封装 API 调用和响应式状态
- [x] 5.2 页面级 useEventSource 集成 — 会话列表页建立 SSE，聊天详情页用轮询

## 6. 前端页面

- [x] 6.1 新建 `noj-ui/pages/messages/index.vue` — 会话列表页（含空状态、SSE 实时刷新）
- [x] 6.2 新建 `noj-ui/pages/messages/[id].vue` — 聊天详情页（消息气泡、发送、已读标记、加载更多）

## 7. 前端集成

- [x] 7.1 修改 `noj-ui/components/Navbar.vue` — 添加私信图标和未读徽标
- [x] 7.2 修改 `noj-ui/pages/users/[id].vue` — 添加"发送私信"按钮

## 8. 端到端验证

- [ ] 8.1 启动全栈环境（docker compose + noj-core + noj-ui）
- [ ] 8.2 两个浏览器窗口分别登录不同用户，交叉发消息验证实时推送和轮询降级
- [ ] 8.3 验证未读徽标、已读标记、消息删除、已注销用户等边界情况
