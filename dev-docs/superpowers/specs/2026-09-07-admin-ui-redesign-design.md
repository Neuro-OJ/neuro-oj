# Admin UI 重做设计

> Status: Draft
> Date: 2026-09-07
> Scope: 一次性重做全部管理页面

## 背景与目标

当前管理后台存在以下问题：

- 各管理页面的表格、表单、弹窗、刷新逻辑重复且不一致。
- 多管理员同时编辑时缺少冲突保护，容易互相覆盖。
- 数据刷新不及时，部分页面需要手动刷新。
- 侧边栏/页面层级/信息架构混乱。
- 移动端与可访问性体验不足。

本次重做目标：

1. 后端建立**单一 admin 域 + 内部 sub domain**，统一管理端 API 表面。
2. 提供**统一审计封装**，集中记录管理员操作并补齐缺失调用。
3. 以**乐观并发控制**解决多管理员同时编辑的冲突问题。
4. 前端建立**统一管理面板组件体系**，重做交互逻辑、信息架构、响应式与可访问性。
5. 实时同步仅保留在少数真正需要的场景（提交/评测队列、仪表盘统计），不建立通用 admin SSE。

## 方案选择

采用**方案 A：统一 Admin 域 + AdminShell 组件体系**。

- 后端新增 `domains/admin` 作为统一门面层，内部按 sub domain 组织。
- 前端建立统一组件族，所有管理页迁移到同一套交互模式。
- 实时同步采用 KISS 原则：移除通用 admin SSE，保留乐观锁，仅复用现有 SSE 端点。

## 后端设计

### 1. Admin 域结构

新增 `noj-core/src/domains/admin/`：

```text
noj-core/src/domains/admin/
├── index.ts                 # 导出 adminRouter
├── routes/
│   ├── identity.ts           # /api/v1/admin/identity/*
│   ├── catalog.ts            # /api/v1/admin/catalog/*
│   ├── contest.ts            # /api/v1/admin/contest/*
│   ├── system.ts             # /api/v1/admin/system/*
│   ├── community.ts          # /api/v1/admin/community/*
│   ├── gateway.ts            # /api/v1/admin/gateway/*
│   ├── submission.ts         # /api/v1/admin/submission/*
│   └── query.ts              # /api/v1/admin/query/*
├── middleware/
│   ├── admin-auth.ts         # 认证 + 管理员/细粒度权限
│   ├── admin-audit.ts        # 统一审计封装入口
│   └── admin-version.ts      # 乐观锁版本校验
├── services/
│   ├── admin-audit.ts        # 审计注册表 + 统一写入
│   ├── admin-version.ts      # updated_at/version 读取与冲突构造
│   └── admin-registry.ts     # sub domain 路由注册表
└── types/
    ├── admin-api.ts
    └── admin-audit.ts
```

### 2. API 路径

重新设计为：

```text
/api/v1/admin/identity/users|roles|blacklist
/api/v1/admin/catalog/problems|tags|trainings
/api/v1/admin/contest/contests
/api/v1/admin/system/settings|announcements|judge-images|audit-logs|email
/api/v1/admin/community/boards|reports|sanctions|content-review
/api/v1/admin/gateway/llm/providers|usage
/api/v1/admin/submission/submissions|queue
/api/v1/admin/query/dashboard|observability
```

原则：

- Admin 域是门面/编排层，不复制业务逻辑；调用现有业务域 service。
- 现有业务域中的 `admin-*.ts` 路由迁入 admin 域后删除；公开路由保留。
- 组级守卫统一在 `adminRouter` 挂载：`authMiddleware` + `adminMiddleware`，细粒度权限通过 `requirePermission` 在具体路由上声明。
- 旧路径不保留，前端一次性切换到新路径。

### 3. 统一审计封装

新增 `services/admin-audit.ts`：

- **审计注册表**：`AuditActionRegistry` 把“sub domain + 路由 + 方法”映射到 `AuditAction` 和 detail 构造器。
- **统一写入函数**：`adminAudit(c, action, detail, target?)` 封装现有 `logAudit()`，自动从 RequestContext 取 actor/ip，保证幂等。
- **路由级辅助**：`withAudit(handler, meta)` 包装写操作 handler，成功响应后自动写审计。
- **补齐缺失调用**：盘点所有 admin 写操作，替换已有 `logAudit` 为 `adminAudit`，并为尚未审计的操作补上审计。
- **审计查询 API**：
  - `GET /api/v1/admin/system/audit-logs`（新路径，保留现有筛选/分页）
  - `GET /api/v1/admin/system/audit-logs/actions`（返回可用 action 列表）
- **安全约束**：detail 构造器禁止记录密码、Token、密钥等敏感字段。

### 4. 乐观并发控制

- 用资源的 `updated_at` 作为乐观锁版本令牌；已有 `version` 整数的资源继续用 `version`。
- 缺少 `updated_at` 的管理资源通过 Drizzle 迁移补列。
- 所有 admin 列表/详情响应统一包含 `updated_at`（或 `version`）字段。
- 写操作要求客户端携带 `If-Match: <updated_at>` 头或请求体 `version` 字段。
- 服务端比较不一致时返回 `409 Conflict`，响应体包含 `{ code: "VERSION_CONFLICT", current: { ...当前资源 } }`。
- 只读资源（审计日志、用量统计等）不要求版本。

### 5. 实时同步（KISS 修订）

- **移除**通用 `/api/v1/admin/events` 和 `noj:events:admin:*` 频道。
- 并发一致性完全依赖乐观锁。
- 保留的实时能力：
  - 提交/评测队列：管理端复用现有 `/api/v1/queue/events`、`/api/v1/submissions/:id/events`。
  - 仪表盘统计：复用现有 `/api/v1/submissions/stats/events`，或在其基础上扩展管理员聚合字段。
- 前端不新增全局 `useAdminRealtime`；仅现有 `useEventSource` 在提交/队列/仪表盘页面按需使用。

## 前端设计

### 6. 统一组件体系

新增 `components/admin/`：

```text
components/admin/
├── AdminShell.vue            # 管理页外壳：页头、操作区、内容区
├── AdminPageHeader.vue       # 统一页头（标题、描述、面包屑、操作按钮）
├── AdminTable.vue            # 通用表格：列配置、分页、搜索、行操作、空/错/加载态
├── AdminFilterBar.vue        # 通用筛选条
├── AdminEditPanel.vue        # 通用编辑面板：草稿、校验、乐观锁、保存/取消
├── AdminFormField.vue        # 统一表单字段包装（label/error/hint）
├── AdminRefreshControl.vue   # 自动/手动刷新控制
├── AdminConfirmDialog.vue    # 统一确认弹窗
├── AdminStatusBadge.vue      # 统一状态徽标
└── AdminDetailDrawer.vue     # 统一详情抽屉
```

新增/重构 composables：

- `useAdminResource`：统一数据获取，集成分页/搜索/版本字段。
- `useAdminForm`：草稿、校验、乐观锁冲突处理。

### 7. 信息架构

侧边栏按 sub domain 分组：

```text
概览
  └ 仪表盘
内容与评测（catalog / contest / submission）
  题目、标签、题单、竞赛、提交、评测镜像
用户与权限（identity）
  用户、角色、黑名单
系统与运维（system）
  系统设置、公告、审计日志
社区与审核（community）
  社区管理、内容审查、举报
LLM 网关（gateway）
  Provider、用量
```

- 侧边栏增加折叠、移动端抽屉、当前页高亮；页面内增加面包屑和统一操作区。
- 表格在移动端降级为卡片列表或横向滚动；编辑面板在移动端变为全屏抽屉。
- 可访问性：保留跳转链接，弹窗焦点管理，表单 label 关联，键盘可操作。

### 8. 并发冲突交互

- `AdminEditPanel` 打开时记录 `updated_at`，保存时自动携带。
- 收到 409 时弹出冲突提示，提供两个操作：
  - **刷新并覆盖**：拉取最新数据，把用户当前未保存的修改合并到新版本上，再次提交。
  - **放弃编辑**：关闭面板，回到最新数据。
- 在复用 SSE 的页面（提交/队列）中，若当前行正在编辑且版本变化，显示“内容已被其他管理员修改”的轻量提示。

## 迁移与测试

### 9. 迁移步骤

1. 后端骨架：新增 `domains/admin` 目录、sub domain 路由、统一中间件、审计注册表、乐观锁迁移。
2. 按 sub domain 迁移：identity → catalog → contest → system → community → gateway → submission → query；每个 sub domain 完成即跑通对应测试。
3. 前端组件库：先建立 `AdminShell/AdminTable/AdminEditPanel` 等基础组件和 `useAdminResource/useAdminForm`。
4. 按页面迁移：所有 `/admin/*` 页面切换到新组件和新 API 路径；每迁移一批跑一次前端测试。
5. 清理：删除旧 admin 路由和旧页面专用代码，更新文档。

### 10. 测试

- 后端：admin 域路由集成测试、审计注册表测试、乐观锁 409 冲突测试、SSE 复用端点回归。
- 前端：`AdminTable`/`AdminEditPanel` 组件测试、关键管理页冒烟测试。
- E2E：管理员登录、CRUD、双管理员并发编辑冲突流程。
- 文档：更新 `noj-core/CLAUDE.md`、`noj-ui/CLAUDE.md`、系统架构文档，并写 Agent Note。

## 实施决策

- 仪表盘统计直接复用公开 `/api/v1/submissions/stats/events`；若 observability 快照需要管理员聚合字段，则在现有端点扩展，不新建 admin SSE。
- 乐观锁统一使用 `updated_at` 作为版本令牌；仅当某资源存在同一毫秒内多次更新风险时，才为该表增加整数 `version` 列。
