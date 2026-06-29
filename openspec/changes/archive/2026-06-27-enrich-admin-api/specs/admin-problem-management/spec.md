## Purpose

定义 Neuro OJ 管理后台题目管理页面规范。该页面在 `/admin/problems` 路径提供，允许管理员管理题目。

本文档为基础规范的 delta 补充，新增管理员专属题目列表接口。

## MODIFIED Requirements

### Requirement: 管理员可查看全部题目列表

系统 SHALL 在 `/admin/problems` 路径提供题目管理页面，以表格形式展示所有题目（含 U 型和 P 型），含 display_id、类型、所有者字段。

后端新增 `GET /api/v1/admin/problems` 端点，依次通过 `authMiddleware` 和 `adminMiddleware` 保护，返回全量题目列表（不默认筛选 type='P'），额外返回 `owner_username` 字段。

#### Scenario: 管理员访问题目管理
- **WHEN** 已登录管理员访问 `/admin/problems`
- **THEN** 系统显示所有类型的题目列表，包含 display_id、标题、类型（U/P 标签）、所有者、难度、分类、创建时间等字段

#### Scenario: 管理员列表支持分页和筛选
- **WHEN** 管理员调用 `GET /api/v1/admin/problems?page=1&limit=20&difficulty=easy`
- **THEN** 系统返回分页的题目列表，支持与普通列表相同的 difficulty、keyword、category_id 筛选参数

#### Scenario: 非管理员拒绝访问
- **WHEN** 普通用户调用 `GET /api/v1/admin/problems`
- **THEN** 系统返回 HTTP 403

### Requirement: 管理员可创建题目

（无变更，保持原有规范）

### Requirement: 管理员可编辑题目

（无变更，保持原有规范）

### Requirement: 管理员可删除题目

（无变更，保持原有规范）
