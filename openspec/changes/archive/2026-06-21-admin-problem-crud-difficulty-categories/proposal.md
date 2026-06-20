## Why

Neuro OJ 当前仅提供公开只读的题目列表与详情接口，管理员无法通过 API 增删改题目，也无法按难度或分类筛选题目。Phase 1 要实现完整的题目管理能力，为后续 noj-ui 的题目列表页、管理后台编辑器提供 API 基础。

## What Changes

- 题目 CRUD 管理端点（管理员权限）：创建、读取、更新、删除题目。
- 难度标签约束：`problems.difficulty` 仅允许 `easy` / `medium` / `hard` 三级，列表支持按难度筛选。
- 分类体系：新增树形分类表与题目-分类关联表，支持多级分类与按分类浏览。
- 题目列表增强：支持按难度、分类、关键词筛选，并保留分页。
- 管理员鉴权：新增 `adminMiddleware`，仅 `role = admin` 的用户可操作管理接口；新增管理员提升 API，由现有管理员 JWT 授权。
- 种子脚本扩展：根据 `ADMIN_EMAIL` 环境变量自动将指定用户提升为管理员，并初始化示例分类。

## Capabilities

### New Capabilities

- `admin-authorization`: 管理员鉴权中间件、管理员提升 API（由现有管理员 JWT 授权）。
- `problem-management`: 题目 CRUD、难度约束、列表筛选与分页。
- `category-management`: 分类树 CRUD、题目与分类的多对多关联。

### Modified Capabilities

- 无。`user-auth` 的注册/登录/获取当前用户接口行为不变，仅复用其 JWT payload 中的 `role` 字段供新的 `admin-authorization` 能力使用。

## Impact

- noj-core：新增/修改路由、服务、中间件、数据库 schema、迁移文件、种子脚本和测试。
- noj-ui（后续）：可调用新 API 实现题目列表筛选、管理后台题目编辑器。
- 数据库：新增 `categories` 表和 `problems_categories` 关联表，并给 `problems.difficulty` 添加 CHECK 约束。
