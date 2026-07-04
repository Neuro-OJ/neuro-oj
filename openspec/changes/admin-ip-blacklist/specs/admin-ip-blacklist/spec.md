## ADDED Requirements

### Requirement: IP 黑名单表 schema

系统 SHALL 提供 `ip_bans` 表，以 key-value 形式持久化 IP / CIDR 封禁条目。表结构 SHALL 包含：

- `id` TEXT PRIMARY KEY
- `ip_or_cidr` TEXT NOT NULL（裸 IP `1.2.3.4` 或 CIDR `10.0.0.0/8`）
- `reason` TEXT NOT NULL DEFAULT ''
- `expires_at` TEXT（ISO 8601；NULL = 永久封禁）
- `created_at` TEXT NOT NULL
- `created_by` TEXT REFERENCES `users(id)` ON DELETE SET NULL

并 SHALL 创建 `idx_ip_bans_ip_or_cidr`（按 ip_or_cidr 查询加速）。

#### Scenario: 启动期创建表

- **WHEN** 全新部署的 noj-core 首次启动（无 `ip_bans` 表）
- **THEN** 0012 迁移执行成功，表存在且索引生效

#### Scenario: 已存在则跳过创建

- **WHEN** `ip_bans` 表已存在（如部分开发环境手动建过）
- **THEN** 0012 迁移 `CREATE TABLE IF NOT EXISTS` 幂等通过，不报错

### Requirement: users 表 banned 字段

`users` 表 SHALL 追加三列：

- `banned` BOOLEAN NOT NULL DEFAULT FALSE
- `banned_reason` TEXT NOT NULL DEFAULT ''
- `banned_until` TEXT（ISO 8601；NULL = 永久封禁）

`banned_until` 字段使用 ISO 8601 文本格式（与项目其他时间字段一致）。

#### Scenario: 启动期加列

- **WHEN** 全新部署 noj-core（users 表无 banned 字段）
- **THEN** 0012 迁移 `ALTER TABLE … ADD COLUMN IF NOT EXISTS` 执行成功，三列生效

#### Scenario: 已存在则跳过加列

- **WHEN** `users.banned` 已存在
- **THEN** 0012 迁移 `IF NOT EXISTS` 子句幂等通过

### Requirement: 运行时 IP 黑名单拦截

`noj-core` SHALL 在 `authMiddleware` 之前挂载 `banlistMiddleware`，对每个请求执行：

1. 调用 `getClientIp(c)` 解析客户端 IP（沿用 `rateLimitEnv.ts:53`）
2. 从 `ip_bans` 表查询所有未过期条目（`WHERE expires_at IS NULL OR expires_at > now`）
3. 用 `isBannedIp(clientIp, ranges)` 匹配（CIDR + 裸 IP 范围）
4. 命中 → `throw new ForbiddenError("IP 已被加入黑名单", "IP_BLACKLISTED")`

`isBannedIp` SHALL 支持 IPv4 裸 IP（`1.2.3.4`）与 IPv4 CIDR（`10.0.0.0/8`）。IPv6 不在本版本支持范围。

中间件 SHALL 60s TTL LRU 缓存 `ip_bans` 列表，避免每请求查 DB（与 system-settings 同模式）。

#### Scenario: 裸 IP 命中拦截

- **WHEN** `ip_bans` 表存在 `ip_or_cidr='1.2.3.4'` 且未过期
- **AND** 客户端 `X-Forwarded-For: 1.2.3.4`
- **THEN** 响应 403 + `{"error": "IP 已被加入黑名单", "code": "IP_BLACKLISTED"}`

#### Scenario: CIDR 范围匹配

- **WHEN** `ip_bans` 表存在 `ip_or_cidr='10.0.0.0/8'`
- **AND** 客户端 `X-Forwarded-For: 10.5.3.7`
- **THEN** 响应 403 + IP_BLACKLISTED

#### Scenario: 过期条目自动忽略

- **WHEN** `ip_bans` 表存在 `ip_or_cidr='1.2.3.4'` 且 `expires_at < now`
- **AND** 客户端 IP 1.2.3.4
- **THEN** 不抛错，正常路由

#### Scenario: 未命中放行

- **WHEN** `ip_bans` 表为空
- **AND** 任何客户端 IP
- **THEN** 不抛错，正常路由

#### Scenario: 60s 缓存生效

- **WHEN** admin 新增 IP 黑名单条目
- **AND** 30 秒内客户端命中 IP 请求
- **THEN** 立即 403（因为 `invalidateBanCache(ip_or_cidr)` 触发缓存失效）

### Requirement: 用户封禁状态校验

`noj-core` SHALL 在 `authMiddleware` 中（`c.set("userId", ...)` 之后、`await next()` 之前）查询 `users.banned / banned_reason / banned_until`，命中则抛 `ForbiddenError("账号已被封禁", "USER_BANNED")`。

校验 SHALL 跳过以下白名单路径（让 banned 用户仍可登录查 ban 原因 / 登出）：

- `/api/v1/auth/login`
- `/api/v1/auth/logout`
- `/api/v1/auth/me`

校验 SHALL 60s TTL LRU 缓存 `userId → BanState`。`banUser` / `unbanUser` 写入时调用 `invalidateBanCache(userId)` 立即失效。

#### Scenario: 已封禁用户受认证请求 403

- **WHEN** 用户已被 ban（`users.banned = true`，未过期）
- **AND** 携带有效 JWT 访问受保护端点（如 `/api/v1/submissions`）
- **THEN** 响应 403 + `{"error": "账号已被封禁", "code": "USER_BANNED"}`

#### Scenario: 临时封禁到期后自动放行

- **WHEN** 用户 `banned=true` 但 `banned_until < now`
- **AND** 携带有效 JWT 访问
- **THEN** 不抛错，正常路由

#### Scenario: banned 用户登录仍可

- **WHEN** 用户已 ban 但 `POST /api/v1/auth/login` 请求
- **THEN** 业务层登录服务应返 403 + USER_BANNED（携带 reason / until 元数据，issue 验收项）

#### Scenario: banned 用户 /me 可查

- **WHEN** 用户已 ban 且 `GET /api/v1/auth/me` 请求
- **THEN** 响应 200，body 含 `banned: true, banned_reason, banned_until`

#### Scenario: 60s 缓存失效

- **WHEN** admin 调用 `PATCH /api/v1/admin/users/:id/unban` 成功
- **AND** 该用户立即（< 60s）携带旧 JWT 访问受保护端点
- **THEN** 正常路由（200），不返 403

### Requirement: 管理员 IP 黑名单端点

`noj-core` SHALL 提供 3 个 admin 端点（鉴权由 `routes/admin.ts:30` 组级 `authMiddleware + adminMiddleware` 自动覆盖）：

| 方法 | 路径 | body | 响应 |
|------|------|------|------|
| GET | `/api/v1/admin/blacklist` | — | `{ data: IpBan[], pagination: { ... } }` |
| POST | `/api/v1/admin/blacklist` | `{ ip_or_cidr, reason?, expires_at? }` | `{ data: IpBan }` 201 |
| DELETE | `/api/v1/admin/blacklist/:id` | — | 204 |

校验规则：
- `ip_or_cidr` 必须是合法 IPv4 裸 IP 或 CIDR，否则返 400
- `ip_or_cidr` 不得为 `0.0.0.0/0`（避免封整个 IPv4 互联网），否则返 400
- `ip_or_cidr` 不得与现有条目重复，否则返 409
- `expires_at`（如提供）必须是有效 ISO 8601 字符串

成功后 SHALL 失效 `ip_bans` LRU 缓存（`invalidateBanCache()`）。

审计日志：`console.log("[admin] actor=<userId> action=POST key=ip_bans value=<ip_or_cidr>")`。

#### Scenario: 新增 IP 黑名单

- **WHEN** admin 调用 `POST /api/v1/admin/blacklist` body=`{ ip_or_cidr: "1.2.3.4", reason: "spam" }`
- **THEN** DB 行 INSERT 成功，响应 201 + `{ data: { id, ip_or_cidr: "1.2.3.4", ... } }`

#### Scenario: 新增 CIDR 黑名单

- **WHEN** admin 调用 `POST` body=`{ ip_or_cidr: "10.0.0.0/8", expires_at: "2027-12-31T23:59:59Z" }`
- **THEN** 响应 201，DB 行 expires_at 字段保存为 ISO 8601 字符串

#### Scenario: 拒绝 0.0.0.0/0

- **WHEN** admin 调用 `POST` body=`{ ip_or_cidr: "0.0.0.0/0" }`
- **THEN** 响应 400，message: "IP/CIDR 不能是 0.0.0.0/0（会封禁整个 IPv4 互联网）"

#### Scenario: 拒绝非法 CIDR

- **WHEN** admin 调用 `POST` body=`{ ip_or_cidr: "abc" }`
- **THEN** 响应 400，message: "IP/CIDR 格式无效"

#### Scenario: 拒绝重复 IP

- **WHEN** DB 已存在 `ip_or_cidr="1.2.3.4"`
- **AND** admin 调用 `POST` body=`{ ip_or_cidr: "1.2.3.4" }`
- **THEN** 响应 409，message: "IP/CIDR 已存在"

#### Scenario: 列表分页

- **WHEN** admin 调用 `GET /api/v1/admin/blacklist?page=2&per_page=20`
- **THEN** 响应 200 + `{ data: IpBan[20], pagination: { page: 2, total, total_pages } }`

#### Scenario: 列表模糊搜索

- **WHEN** admin 调用 `GET /api/v1/admin/blacklist?keyword=10.0`
- **THEN** data 中仅包含 `ip_or_cidr` 含 "10.0" 的条目

#### Scenario: 删除黑名单条目

- **WHEN** admin 调用 `DELETE /api/v1/admin/blacklist/<id>`
- **THEN** 响应 204，DB 行删除，立即失效 LRU 缓存

### Requirement: 管理员用户封禁端点

`noj-core` SHALL 提供 2 个 admin 端点：

| 方法 | 路径 | body | 响应 |
|------|------|------|------|
| PATCH | `/api/v1/admin/users/:id/ban` | `{ reason?, banned_until? }` | `{ data: User }` 200 |
| PATCH | `/api/v1/admin/users/:id/unban` | — | `{ data: User }` 200 |

业务规则：
- 禁止封禁自己（`currentUserId === targetUserId`），返 400
- 禁止封禁 root（`targetUserId === '0'`），返 400
- 禁止封禁最后一个可登录 admin（仿 `promoteUser` 防护），返 400
- 目标用户必须存在，否则返 404
- `banned_until`（如提供）必须是有效 ISO 8601

成功后 SHALL 失效 `users.banned` LRU 缓存（`invalidateBanCache(targetUserId)`）。

审计日志：`console.log("[admin] actor=<userId> action=PUT key=user_ban value=<targetUserId>")`。

#### Scenario: 封禁用户（永久）

- **WHEN** admin 调用 `PATCH /api/v1/admin/users/<id>/ban` body=`{ reason: "spam" }`
- **THEN** DB 行 UPDATE 成功（`banned=true, banned_reason="spam", banned_until=null`），响应 200 + `{ data: User }`

#### Scenario: 临时封禁

- **WHEN** admin 调用 `PATCH` body=`{ reason: "违规警告", banned_until: "2026-12-31T23:59:59Z" }`
- **THEN** DB 行 `banned_until` 保存为 ISO 8601 字符串

#### Scenario: 拒绝封禁自己

- **WHEN** admin 调用 `PATCH /api/v1/admin/users/<自己id>/ban`
- **THEN** 响应 400，message: "不能封禁自己"

#### Scenario: 拒绝封禁 root

- **WHEN** admin 调用 `PATCH /api/v1/admin/users/0/ban`
- **THEN** 响应 400，message: "不能封禁 root 账户"

#### Scenario: 拒绝封禁最后一个 admin

- **WHEN** 系统只有 1 个可登录 admin
- **AND** 该 admin 调用 `PATCH /api/v1/admin/users/<自己id>/ban`
- **THEN** 响应 400（防自封禁规则先触发）

#### Scenario: 用户不存在 404

- **WHEN** admin 调用 `PATCH /api/v1/admin/users/<不存在id>/ban`
- **THEN** 响应 404，message: "用户不存在"

#### Scenario: 解封用户

- **WHEN** admin 调用 `PATCH /api/v1/admin/users/<id>/unban`
- **THEN** DB 行 `banned=false, banned_reason='', banned_until=null`，响应 200 + `{ data: User }`

### Requirement: 前端黑名单管理页面

`noj-ui` SHALL 提供 `pages/admin/blacklist.vue`，路径 `/admin/blacklist`，仅 admin 可见。

页面 SHALL 包含：
- 顶部"新增黑名单"按钮 → `AdminModal` 表单（IP/CIDR / 原因 / 过期时间）
- `AdminTable` 表格：IP/CIDR / 原因 / 过期时间 / 创建时间 / 操作
- 操作列：删除按钮 → `useDialog().confirm()` 二次确认 → `DELETE /api/v1/admin/blacklist/:id`
- 分页（`PaginationNav`）+ 搜索（按 ip_or_cidr 模糊）

页面 SHALL 复用 `AdminTable` / `AdminModal` / `useDialog` / `useToast`，与 `pages/admin/categories.vue` 风格保持一致。

#### Scenario: admin 访问页面

- **WHEN** admin 用户访问 `/admin/blacklist`
- **THEN** 页面渲染，表格加载现有 IP 黑名单列表

#### Scenario: 新增 IP 黑名单

- **WHEN** admin 点"新增"按钮 → 填写 `1.2.3.4` + reason → 确认
- **THEN** `POST /api/v1/admin/blacklist` 调用 → toast.success → 表格刷新

#### Scenario: 删除黑名单条目

- **WHEN** admin 点行内"删除"按钮 → 二次确认对话框 → 确认
- **THEN** `DELETE /api/v1/admin/blacklist/:id` 调用 → toast.success → 行消失

#### Scenario: 普通用户被重定向

- **WHEN** 非 admin 用户访问 `/admin/blacklist`
- **THEN** `middleware/admin.ts` 静默重定向到 `/`（首页）

### Requirement: 前端用户封禁交互

`noj-ui/pages/admin/users.vue` SHALL 在表格操作列加"封禁 / 解封"按钮，按 `row.banned` 切换文案：

- `banned=false` → "封禁"按钮（红色），点击 → `AdminModal` 表单（reason / banned_until）
- `banned=true` → "解封"按钮（蓝色），点击 → `useDialog().confirm()` 二次确认

已封禁用户 username 列右侧 SHALL 显示红色 "已封禁" badge（`bg-red-100 text-red-800`）。

`UserResponse` 与 `SessionData` 类型 SHALL 扩展 `banned: boolean` 字段（`composables/useAuth.ts`）。

#### Scenario: 封禁用户

- **WHEN** admin 在 `/admin/users` 点击"封禁"按钮 → 填写 reason → 确认
- **THEN** `PATCH /api/v1/admin/users/:id/ban` 调用 → toast.success → 表格刷新（badge 出现）

#### Scenario: 解封用户

- **WHEN** admin 点击"解封"按钮 → 二次确认 → 确认
- **THEN** `PATCH /api/v1/admin/users/:id/unban` 调用 → toast.success → badge 消失

#### Scenario: banned 字段透传

- **WHEN** `GET /api/v1/admin/users` 响应
- **THEN** `UserResponse.banned` 字段存在且准确反映 DB 状态

### Requirement: 登录页 banned 拦截

`noj-ui/pages/login.vue` SHALL 支持 `?banned=1&reason=...&until=...` query，渲染红色 banner：

- 永久 ban：banner 显示"账号已被封禁。{reason}。请联系管理员。"
- 临时 ban：banner 显示"账号已被封禁至 {until}。{reason}。"

后端 `POST /api/v1/auth/login` SHALL 在用户 banned 时返 403 + `{"code": "USER_BANNED", "reason": "...", "until": "..."}`，前端 catch 后 `router.replace("/login?banned=1&reason=...&until=...")`。

#### Scenario: 永久 ban 登录拦截

- **WHEN** 用户被永久 ban（`banned_until=null`）调用 `POST /api/v1/auth/login`
- **THEN** 响应 403 + `{"code": "USER_BANNED", "reason": "spam", "until": null}`，前端跳 `/login?banned=1&reason=spam` 渲染红色 banner

#### Scenario: 临时 ban 登录拦截

- **WHEN** 用户被临时 ban（`banned_until="2026-12-31..."`）调用 `POST /api/v1/auth/login`
- **THEN** 响应 403 + `{"code": "USER_BANNED", "until": "2026-12-31..."}`，前端跳 `/login?banned=1&reason=...&until=2026-12-31...`

#### Scenario: 解封后登录成功

- **WHEN** 用户已被解封（`banned=false`）调用 `POST /api/v1/auth/login`
- **THEN** 响应 200 + token，正常登录

## 关联依赖

- `authMiddleware` 已有 `must_change_password` 白名单机制（`PASSWORD_CHANGE_WHITELIST`），banned 检查沿用相同模式
- `getClientIp()` 已实现于 `src/lib/rateLimitEnv.ts:53`，零修改直接复用
- `promoteUser` 模板在 `src/services/auth.ts:230`，`banUser` / `unbanUser` 仿写
- `ForbiddenError` 已支持可选 `code` 参数（issue #75 引入），无需新建错误类
- `[admin]` console 日志前缀已建立（issue #99），本 PR 沿用
