## MODIFIED Requirements

### Requirement: 前端黑名单管理页面

`noj-ui` SHALL 提供 `pages/admin/blacklist.vue`，路径 `/admin/blacklist`，仅 admin 可见。

页面 SHALL 包含：
- 顶部"新增黑名单"按钮 → `AdminModal` 表单（IP/CIDR / 原因 / 过期时间）
- `AdminTable` 表格：IP/CIDR / 原因 / 过期时间 / 创建时间 / 操作
- 操作列：删除按钮 → `useDialog().confirm()` 二次确认 → `DELETE /api/v1/admin/blacklist/:id`
- 分页（`PaginationNav`）+ 搜索（按 ip_or_cidr 模糊）

页面 SHALL 复用 `AdminTable` / `AdminModal` / `useDialog` / `useToast`，与 `pages/admin/tags.vue` 风格保持一致。

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
