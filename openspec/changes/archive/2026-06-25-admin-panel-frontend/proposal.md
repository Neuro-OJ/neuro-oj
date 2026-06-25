## Why

Neuro OJ 后端已具备完整的管理员 API 基础设施（角色管理、题目/分类 CRUD、提交审核），但前端完全没有管理界面，管理员只能通过直接调用 API 来管理平台。需要一套易用的管理后台面板，让管理员能通过浏览器完成日常运维操作。

## What Changes

- **新增** noj-ui 管理后台页面集合，以独立布局和路由守卫隔离
- **修改** Navbar.vue，管理员用户可在下拉菜单看到管理后台入口
- **新增** noj-core `GET /api/v1/admin/users` 端点，用于用户列表展示
- **新增** 管理路由守卫，非管理员用户无法访问 `/admin/*` 路径
- **覆盖** 以下管理功能：仪表盘概览、用户管理（角色切换）、题目增删改、分类管理、提交审核

## Capabilities

### New Capabilities
- `admin-dashboard`: 管理后台仪表盘，展示平台统计概览（用户数、题目数、提交数）
- `admin-user-management`: 管理员查看用户列表、切换用户角色（admin/user）
- `admin-problem-management`: 管理员创建、编辑、删除题目
- `admin-category-management`: 管理员创建、编辑、删除分类
- `admin-submission-management`: 管理员查看所有用户提交记录，支持多维度筛选

### Modified Capabilities
<!-- 无现有规范需要修改 -->

## Impact

- **noj-ui**: 新增 1 个布局、1 个中间件、2 个共享组件、6 个页面；修改 1 个现有组件
- **noj-core**: 新增 1 个 REST 端点（GET /api/v1/admin/users）+ 对应服务函数
- 不涉及数据库 schema 变更
- 不涉及现有公共页面路由变更
