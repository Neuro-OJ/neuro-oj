## Purpose

定义 IP 黑名单管理功能，提供 `ip_bans` 表持久化及管理员 CRUD 端点，支持 IP/CIDR 级别的访问限制。

## Requirements

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
- **THEN** 迁移执行成功，表存在且索引生效

#### Scenario: 已存在则跳过创建

- **WHEN** `ip_bans` 表已存在
- **THEN** 迁移 `CREATE TABLE IF NOT EXISTS` 幂等通过，不报错

### Requirement: 管理员 IP 黑名单端点

`noj-core` SHALL 提供 3 个 admin 端点：

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
