## Why

当前 noj-core 仅提供 `GET /api/v1/submissions/:id`
获取单条提交详情，用户无法浏览自己的提交历史。评测完成后，用户需要查看所有提交记录的列表，按题目、语言、状态、日期筛选，以便追踪评测进度和定位失败原因。这是
OJ 系统的核心功能之一。

## What Changes

- 新增 `GET /api/v1/submissions`
  端点，返回当前认证用户的提交列表，支持分页和多维度筛选
- 新增 `GET /api/v1/admin/submissions`
  端点，允许管理员查看所有用户的提交（支持按 user_id 筛选）
- 列表响应中附带题目基本信息（title、id），避免前端 N+1 查询
- 筛选参数：`problem_id`、`language`、`status`、`from` / `to`（日期范围）
- 分页方式：offset-based（`page` + `per_page`），简单直观，适合前端分页组件

## Capabilities

### New Capabilities

- `submission-list-api`: 提交历史列表查询
  API，包含分页、筛选、题目信息联查；普通用户查看自己的提交，管理员可查看所有用户提交

### Modified Capabilities

- `admin-authorization`: 新增管理员端点
  `GET /api/v1/admin/submissions`，扩展管理员可访问的受保护路由范围

## Impact

- **Affected code**:
  `noj-core/src/routes/submissions.ts`（新增列表路由）、`noj-core/src/services/submissions.ts`（新增列表查询服务函数）
- **Affected specs**: `admin-authorization`（新增管理端点需在 spec
  中声明）、`database-schema`（需新增复合索引以支持高效的分页+筛选查询）
- **Affected upstream**: `noj-ui` 需在后续变更中实现提交历史页面，调用此 API
