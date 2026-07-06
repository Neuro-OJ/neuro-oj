## Why

NOJ 当前零访问控制与封禁机制：恶意用户可无限刷提交、刷接口；恶意 IP 也没任何阻断手段。issue #102 列出 5 个验收项：IP 黑名单 + 用户封禁，配套 5 个 admin 端点 + 中间件 + 前端 UI。本变更落地"运营可拦截"的核心安全能力。

## What Changes

### 新增能力

- **`ip-blacklist`**：管理员维护的 IP / CIDR 列表 + 运行时中间件拦截
- **`user-ban`**：单个用户的封禁 + 临时禁用（带 reason + 可选到期时间）

### 修改能力

- **`user-auth`**：登录后 `authMiddleware` 增加 banned 状态校验，命中时返 403 `USER_BANNED`（含 reason / until 元数据）
- **`user-management`**：管理员列表 / 详情显示 banned 状态；新增 ban / unban 端点
- **`admin-routes`**：扩展 5 个新端点（blacklist CRUD + users ban / unban）

## Impact

- **数据库**：新增 `ip_bans` 表 + `users` 表追加 `banned` / `banned_reason` / `banned_until` 三列
- **noj-core**：
  - 新增 `src/lib/cidr.ts`（IPv4 + CIDR 手写解析，零新依赖）
  - 新增 `src/lib/banCache.ts`（60s TTL LRU 内存缓存，与 `system-settings` 同模式）
  - 新增 `src/services/banlist.ts`（IP 黑名单 CRUD + 匹配函数）
  - 新增 `src/middleware/banlist.ts`（IP 黑名单中间件）
  - 扩展 `src/middleware/auth.ts`（banned 校验，含白名单）
  - 扩展 `src/services/users.ts`（`banUser` / `unbanUser`）
  - 扩展 `src/services/auth.ts`（`toUserResponse` 加 banned 字段；`listUsers` 支持 banned 筛选）
  - 扩展 `src/routes/admin.ts`（5 个新端点）
  - 扩展 `src/app.ts`（挂 `banlistMiddleware`，在 `authMiddleware` 之前）
- **noj-ui**：
  - 新增 `pages/admin/blacklist.vue`（CRUD 三件套，仿 categories.vue）
  - 改造 `pages/admin/users.vue`（操作列加封禁 / 解封 + banned badge）
  - 改造 `composables/useAuth.ts`（`UserResponse` / `SessionData` 加 banned）
  - 改造 `pages/login.vue`（支持 `?banned=1&reason=...&until=...` banner）
  - 改造 `layouts/admin.vue`（侧栏加"黑名单管理"入口）
- **性能**：`banned` 状态查 DB（60s LRU 缓存），每次受认证请求多一次内存查询；IP 黑名单同样 60s LRU
- **OpenSpec 现有 8 个 capabilities** 不修改，独立新增 2 个

## Out of Scope

- IPv6 CIDR 解析（OJ 场景几乎都是 IPv4；先 IPv4-ready 表结构，后续 PR 加）
- 完整审计日志表（issue #101，独立工作）—— 本 PR 沿用现有 `console.log("[admin] ...")` 前缀
- 自动解封 cron 任务（后端查询 `WHERE banned_until > now` 已天然过滤过期）
- 黑名单导入/导出（5 条端点覆盖 CRUD；后续可加 batch import）
- 申诉 / 临时解封 token
- 实时通知（ban 后立即踢出已登录会话 —— 60s TTL 缓存 + WebSocket 推送都是单独工作）

## 关联

- Closes #102
- 衔接 issue #99（`[admin]` console 日志前缀已建立）
- 衔接 issue #101（完整审计日志表 —— 后续工作）
